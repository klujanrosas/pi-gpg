/**
 * pi-gpg doctor
 *
 * Inspects the GPG / git-signing environment and reports:
 *   - GPG version and binary path
 *   - Which pinentry variants are installed
 *   - `pinentry-program` from gpg-agent.conf (if any)
 *   - Git signing config (global + repo): gpg.program, gpg.format,
 *     user.signingkey, commit.gpgsign, tag.gpgsign
 *   - Available secret keys
 *
 * Produces both a structured `DoctorReport` (for programmatic use, tests,
 * status widgets) and a human-readable multi-line rendering.
 *
 * Pure module: takes an ExecFn for all subprocess work so it is trivially
 * unit-testable without spawning real gpg/git.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExecFn, safeExec } from "./exec.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "ok" | "info" | "warning" | "error";

export interface DoctorFinding {
	id: string;
	severity: Severity;
	title: string;
	detail?: string;
}

export interface PinentryInventory {
	/** Absolute paths of detected pinentry binaries, keyed by variant. */
	found: Record<string, string>;
	/** The variant gpg-agent will pick by default if `pinentry-program` is unset. */
	default: string | null;
}

export interface GitSigningConfig {
	/** git -c gpg.program / git config gpg.program */
	gpgProgram?: string;
	/** "openpgp" | "ssh" | "x509" | undefined */
	gpgFormat?: string;
	/** Long key id or fingerprint. */
	signingKey?: string;
	commitGpgsign?: boolean;
	tagGpgsign?: boolean;
}

export interface DoctorReport {
	cwd: string;
	gpg: {
		path: string | null;
		version: string | null;
	};
	agentConf: {
		path: string;
		exists: boolean;
		pinentryProgram: string | null;
		defaultCacheTtl: number | null;
		maxCacheTtl: number | null;
	};
	pinentry: PinentryInventory;
	git: {
		global: GitSigningConfig;
		repo: GitSigningConfig;
		/**
		 * Effective view: repo values override globals. `undefined` when neither
		 * set.
		 */
		effective: GitSigningConfig;
		/**
		 * `true` when `git commit` (with no -S flag) will try to sign the commit,
		 * based on the effective config.
		 */
		willAutoSignCommits: boolean;
		willAutoSignTags: boolean;
	};
	keys: SecretKey[];
	findings: DoctorFinding[];
}

export interface SecretKey {
	keyid: string;
	fingerprint: string;
	uids: string[];
	/** Creation date (ISO 8601) if we could parse it. */
	created?: string;
	/** Expiration date (ISO 8601) if set. */
	expires?: string;
	/** `true` if `expires` is in the past. */
	expired: boolean;
}

// ---------------------------------------------------------------------------
// Known pinentry variants (ordered by TTY-friendliness)
// ---------------------------------------------------------------------------

/**
 * Ordered so the *first* installed variant we find is the one gpg-agent will
 * likely prefer. macOS prefers the GUI pinentry; Linux prefers gnome/gtk/qt.
 *
 * NOTE: gpg-agent's real default-selection is platform-specific and based on
 * how gpg was built. This list is a heuristic surface for the report, not a
 * binding decision. We only *claim* a default when `pinentry-program` is unset
 * and a GUI variant exists.
 */
export const PINENTRY_VARIANTS = [
	"pinentry-mac",
	"pinentry-gnome3",
	"pinentry-gtk-2",
	"pinentry-qt",
	"pinentry-qt5",
	"pinentry-fltk",
	"pinentry-x11",
	"pinentry", // usually a symlink to the active one
	"pinentry-curses",
	"pinentry-tty",
] as const;

const GUI_VARIANTS = new Set([
	"pinentry-mac",
	"pinentry-gnome3",
	"pinentry-gtk-2",
	"pinentry-qt",
	"pinentry-qt5",
	"pinentry-fltk",
	"pinentry-x11",
]);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface DoctorOptions {
	cwd: string;
	/** Override the path to gpg-agent.conf. Defaults to $GNUPGHOME or ~/.gnupg. */
	gpgAgentConfPath?: string;
	/** Read a file. Injectable for tests. */
	readFile?: (path: string) => Promise<string>;
}

export async function runDoctor(exec: ExecFn, opts: DoctorOptions): Promise<DoctorReport> {
	const run = safeExec(exec);
	const read = opts.readFile ?? ((p) => readFile(p, "utf8"));
	const agentConfPath = opts.gpgAgentConfPath ?? resolveGpgAgentConfPath();

	const [gpgWhich, gpgVersion, pinentry, agentConf, gitGlobal, gitRepo, keys] = await Promise.all([
		run("which", ["gpg"]),
		run("gpg", ["--version"]),
		inventoryPinentries(run),
		parseAgentConf(agentConfPath, read),
		readGitSigningConfig(run, "global"),
		readGitSigningConfig(run, "local", opts.cwd),
		listSecretKeys(run),
	]);

	const effective: GitSigningConfig = {
		gpgProgram: gitRepo.gpgProgram ?? gitGlobal.gpgProgram,
		gpgFormat: gitRepo.gpgFormat ?? gitGlobal.gpgFormat,
		signingKey: gitRepo.signingKey ?? gitGlobal.signingKey,
		commitGpgsign: gitRepo.commitGpgsign ?? gitGlobal.commitGpgsign,
		tagGpgsign: gitRepo.tagGpgsign ?? gitGlobal.tagGpgsign,
	};

	const report: DoctorReport = {
		cwd: opts.cwd,
		gpg: {
			path: gpgWhich.code === 0 ? gpgWhich.stdout.trim() || null : null,
			version: parseGpgVersion(gpgVersion.stdout),
		},
		agentConf: {
			path: agentConfPath,
			...agentConf,
		},
		pinentry,
		git: {
			global: gitGlobal,
			repo: gitRepo,
			effective,
			willAutoSignCommits: effective.commitGpgsign === true,
			willAutoSignTags: effective.tagGpgsign === true,
		},
		keys,
		findings: [],
	};

	report.findings = diagnose(report);
	return report;
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

const SEVERITY_GLYPH: Record<Severity, string> = {
	ok: "✓",
	info: "ℹ",
	warning: "⚠",
	error: "✗",
};

export function renderReport(report: DoctorReport): string {
	const lines: string[] = [];
	lines.push("pi-gpg doctor");
	lines.push("─".repeat(60));

	// GPG
	if (report.gpg.path) {
		lines.push(`gpg       ${report.gpg.path}`);
		if (report.gpg.version) {
			lines.push(`          ${report.gpg.version}`);
		}
	} else {
		lines.push("gpg       (not found on PATH)");
	}

	// Pinentry
	const foundEntries = Object.entries(report.pinentry.found);
	if (foundEntries.length === 0) {
		lines.push("pinentry  (none installed)");
	} else {
		lines.push("pinentry  installed:");
		for (const [name, path] of foundEntries) {
			lines.push(`          ${name.padEnd(18)} ${path}`);
		}
	}

	// gpg-agent.conf
	if (report.agentConf.exists) {
		lines.push(`agent     ${report.agentConf.path}`);
		lines.push(`          pinentry-program: ${report.agentConf.pinentryProgram ?? "(unset)"}`);
		if (report.agentConf.defaultCacheTtl != null) {
			lines.push(`          default-cache-ttl: ${report.agentConf.defaultCacheTtl}s`);
		}
		if (report.agentConf.maxCacheTtl != null) {
			lines.push(`          max-cache-ttl:     ${report.agentConf.maxCacheTtl}s`);
		}
	} else {
		lines.push(`agent     ${report.agentConf.path} (not present — defaults apply)`);
	}

	// Git config
	lines.push("git       effective signing config:");
	const eff = report.git.effective;
	lines.push(`          gpg.program       ${eff.gpgProgram ?? "(default: gpg)"}`);
	lines.push(`          gpg.format        ${eff.gpgFormat ?? "openpgp (default)"}`);
	lines.push(`          user.signingkey   ${eff.signingKey ?? "(unset)"}`);
	lines.push(`          commit.gpgsign    ${fmtBool(eff.commitGpgsign)}`);
	lines.push(`          tag.gpgsign       ${fmtBool(eff.tagGpgsign)}`);

	// Keys
	if (report.keys.length === 0) {
		lines.push("keys      (no secret keys found)");
	} else {
		lines.push(`keys      ${report.keys.length} secret key(s):`);
		for (const key of report.keys) {
			const status = key.expired ? " [EXPIRED]" : "";
			const primary = key.uids[0] ?? "(no user id)";
			lines.push(`          ${key.keyid}  ${primary}${status}`);
		}
	}

	// Findings
	if (report.findings.length > 0) {
		lines.push("");
		lines.push("findings:");
		for (const f of report.findings) {
			lines.push(`  ${SEVERITY_GLYPH[f.severity]} ${f.title}`);
			if (f.detail) {
				for (const dl of f.detail.split("\n")) {
					lines.push(`      ${dl}`);
				}
			}
		}
	}

	return lines.join("\n");
}

function fmtBool(v: boolean | undefined): string {
	if (v === undefined) return "(unset)";
	return v ? "true" : "false";
}

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export function diagnose(report: DoctorReport): DoctorFinding[] {
	const out: DoctorFinding[] = [];

	if (!report.gpg.path) {
		out.push({
			id: "gpg-missing",
			severity: "error",
			title: "gpg binary not found on PATH",
			detail: "Install GnuPG (e.g. `brew install gnupg` on macOS).",
		});
	}

	// Pinentry analysis
	const hasGui = Object.keys(report.pinentry.found).some((name) => GUI_VARIANTS.has(name));
	const hasOnlyTty =
		!hasGui &&
		Object.keys(report.pinentry.found).some((name) => name === "pinentry-curses" || name === "pinentry-tty");
	const explicit = report.agentConf.pinentryProgram;

	if (hasOnlyTty && !explicit) {
		out.push({
			id: "pinentry-tty-only",
			severity: "warning",
			title: "Only TTY-based pinentry is installed",
			detail:
				"gpg-agent will spawn pinentry-curses/tty and take over the terminal, which garbles AI-agent sessions. pi-gpg will route the passphrase prompt through Pi instead, but for other tooling you may want `brew install pinentry-mac` (macOS) or the GUI pinentry for your desktop.",
		});
	}

	if (explicit && !Object.values(report.pinentry.found).includes(explicit)) {
		out.push({
			id: "pinentry-missing",
			severity: "warning",
			title: `gpg-agent.conf points at a pinentry that does not exist: ${explicit}`,
			detail: "Either install that binary or remove the `pinentry-program` line.",
		});
	}

	// Signing config
	const eff = report.git.effective;
	if (eff.commitGpgsign) {
		out.push({
			id: "commit-gpgsign-on",
			severity: "info",
			title: "commit.gpgsign is enabled — every commit will be signed",
		});
	}
	if (eff.tagGpgsign) {
		out.push({
			id: "tag-gpgsign-on",
			severity: "info",
			title: "tag.gpgsign is enabled — every annotated tag will be signed",
		});
	}

	if ((eff.commitGpgsign || eff.tagGpgsign) && !eff.signingKey) {
		out.push({
			id: "signing-no-key",
			severity: "warning",
			title: "Signing is enabled but user.signingkey is unset",
			detail:
				"Git will try to pick a default secret key, which is fragile. Set `git config user.signingkey <KEYID>`.",
		});
	}

	if (eff.gpgFormat === "ssh") {
		out.push({
			id: "ssh-signing",
			severity: "ok",
			title: "gpg.format = ssh — agent-safe by design",
			detail:
				"SSH signing uses your ssh-agent (or Secure Enclave) instead of gpg-agent, so there is no pinentry. pi-gpg is not strictly needed for signing in this setup, but we'll still wire `git_commit` for consistency.",
		});
	}

	// Expired keys
	const expiredKeys = report.keys.filter((k) => k.expired);
	if (expiredKeys.length > 0) {
		out.push({
			id: "keys-expired",
			severity: "warning",
			title: `${expiredKeys.length} secret key(s) expired`,
			detail: expiredKeys.map((k) => `  ${k.keyid}  ${k.uids[0] ?? ""}`).join("\n"),
		});
	}

	if (out.length === 0) {
		out.push({
			id: "all-clear",
			severity: "ok",
			title: "Environment looks healthy.",
		});
	}

	return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveGpgAgentConfPath(): string {
	const gnupgHome = process.env.GNUPGHOME;
	const base = gnupgHome && gnupgHome.length > 0 ? gnupgHome : join(homedir(), ".gnupg");
	return join(base, "gpg-agent.conf");
}

async function inventoryPinentries(run: ExecFn): Promise<PinentryInventory> {
	const found: Record<string, string> = {};
	await Promise.all(
		PINENTRY_VARIANTS.map(async (name) => {
			const res = await run("which", [name]);
			if (res.code === 0) {
				const path = res.stdout.trim();
				if (path.length > 0) found[name] = path;
			}
		}),
	);
	// Heuristic: the first GUI variant we find is the probable default.
	let defaultVariant: string | null = null;
	for (const name of PINENTRY_VARIANTS) {
		if (found[name] && GUI_VARIANTS.has(name)) {
			defaultVariant = name;
			break;
		}
	}
	return { found, default: defaultVariant };
}

interface ParsedAgentConf {
	exists: boolean;
	pinentryProgram: string | null;
	defaultCacheTtl: number | null;
	maxCacheTtl: number | null;
}

async function parseAgentConf(path: string, read: (p: string) => Promise<string>): Promise<ParsedAgentConf> {
	let raw: string;
	try {
		raw = await read(path);
	} catch {
		return { exists: false, pinentryProgram: null, defaultCacheTtl: null, maxCacheTtl: null };
	}

	let pinentryProgram: string | null = null;
	let defaultCacheTtl: number | null = null;
	let maxCacheTtl: number | null = null;

	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const [key, ...rest] = line.split(/\s+/);
		const value = rest.join(" ").trim();
		if (!key) continue;
		switch (key) {
			case "pinentry-program":
				pinentryProgram = value;
				break;
			case "default-cache-ttl": {
				const n = Number.parseInt(value, 10);
				if (Number.isFinite(n)) defaultCacheTtl = n;
				break;
			}
			case "max-cache-ttl": {
				const n = Number.parseInt(value, 10);
				if (Number.isFinite(n)) maxCacheTtl = n;
				break;
			}
		}
	}

	return { exists: true, pinentryProgram, defaultCacheTtl, maxCacheTtl };
}

async function readGitSigningConfig(run: ExecFn, scope: "global" | "local", cwd?: string): Promise<GitSigningConfig> {
	const scopeFlag = scope === "global" ? "--global" : "--local";
	const cfg: GitSigningConfig = {};

	// For `--local` we need to cd into cwd; git will fail if not inside a repo.
	const args = (key: string) =>
		cwd && scope === "local" ? ["-C", cwd, "config", scopeFlag, "--get", key] : ["config", scopeFlag, "--get", key];

	const [gpgProgram, gpgFormat, signingKey, commitGpgsign, tagGpgsign] = await Promise.all([
		run("git", args("gpg.program")),
		run("git", args("gpg.format")),
		run("git", args("user.signingkey")),
		run("git", args("commit.gpgsign")),
		run("git", args("tag.gpgsign")),
	]);

	if (gpgProgram.code === 0 && gpgProgram.stdout.trim()) cfg.gpgProgram = gpgProgram.stdout.trim();
	if (gpgFormat.code === 0 && gpgFormat.stdout.trim()) cfg.gpgFormat = gpgFormat.stdout.trim();
	if (signingKey.code === 0 && signingKey.stdout.trim()) cfg.signingKey = signingKey.stdout.trim();
	if (commitGpgsign.code === 0) {
		const v = commitGpgsign.stdout.trim().toLowerCase();
		if (v === "true") cfg.commitGpgsign = true;
		else if (v === "false") cfg.commitGpgsign = false;
	}
	if (tagGpgsign.code === 0) {
		const v = tagGpgsign.stdout.trim().toLowerCase();
		if (v === "true") cfg.tagGpgsign = true;
		else if (v === "false") cfg.tagGpgsign = false;
	}

	return cfg;
}

async function listSecretKeys(run: ExecFn): Promise<SecretKey[]> {
	// --with-colons is the only stable machine-parseable format.
	// Spec: https://git.gnupg.org/cgi-bin/gitweb.cgi?p=gnupg.git;a=blob_plain;f=doc/DETAILS
	const res = await run("gpg", ["--list-secret-keys", "--with-colons", "--fixed-list-mode"]);
	if (res.code !== 0) return [];
	return parseColonKeys(res.stdout);
}

export function parseColonKeys(raw: string): SecretKey[] {
	const keys: SecretKey[] = [];
	let current: Partial<SecretKey> & { uids: string[] } = { uids: [] };
	let currentStarted = false;

	const flush = () => {
		if (currentStarted && current.keyid && current.fingerprint) {
			keys.push({
				keyid: current.keyid,
				fingerprint: current.fingerprint,
				uids: current.uids,
				created: current.created,
				expires: current.expires,
				expired: Boolean(current.expired),
			});
		}
		current = { uids: [] };
		currentStarted = false;
	};

	for (const line of raw.split(/\r?\n/)) {
		if (line.length === 0) continue;
		const cols = line.split(":");
		const type = cols[0];
		if (type === "sec") {
			flush();
			currentStarted = true;
			// cols[4] = keyid, cols[5] = creation, cols[6] = expiration, cols[1] = validity
			current.keyid = cols[4] ?? "";
			current.created = epochToIso(cols[5]);
			current.expires = epochToIso(cols[6]);
			current.expired = cols[1] === "e" || isExpired(cols[6]);
		} else if (type === "fpr" && currentStarted && !current.fingerprint) {
			// first fpr after sec is the primary key fingerprint
			current.fingerprint = cols[9] ?? "";
		} else if (type === "uid" && currentStarted) {
			const uid = cols[9];
			if (uid) current.uids.push(unescapeColonField(uid));
		}
	}
	flush();
	return keys;
}

function epochToIso(raw: string | undefined): string | undefined {
	if (!raw || raw.length === 0) return undefined;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return new Date(n * 1000).toISOString();
}

function isExpired(rawEpoch: string | undefined): boolean {
	if (!rawEpoch || rawEpoch.length === 0) return false;
	const n = Number.parseInt(rawEpoch, 10);
	if (!Number.isFinite(n) || n <= 0) return false;
	return n * 1000 < Date.now();
}

function unescapeColonField(s: string): string {
	// GnuPG escapes \x<hh> in colon-listing output.
	return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export function parseGpgVersion(stdout: string): string | null {
	const first = stdout.split(/\r?\n/)[0];
	if (!first) return null;
	// e.g. "gpg (GnuPG) 2.4.5"
	const match = first.match(/gpg\s+\([^)]+\)\s+([\w.]+)/);
	return match?.[1] ?? (first.trim() || null);
}

/**
 * pi-gpg — Pi extension for agent-safe GPG commit signing.
 *
 * Phase 1 adds:
 *   - `git_commit` tool (fd-3 passphrase flow, no disk exposure)
 *   - bash interception for `git (commit|tag|merge|rebase|cherry-pick|revert|am)`
 *     with passphrase-file flow, auto-cleanup, and a `ctx.ui.notify` so the
 *     user sees when we're rewriting
 *   - session-scoped passphrase cache (gpg-agent defaults: 600s idle / 7200s max)
 *   - /gpg-unlock, /gpg-lock, /gpg-status commands with real behavior
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS, PassphraseCache } from "./cache.js";
import { createFileConfigStore, describeConfig, type PiGpgConfig } from "./config.js";
import { analyzeCommand, type GitSigningConfigSnapshot } from "./detect.js";
import { renderReport, runDoctor, type SecretKey } from "./doctor.js";
import { buildBashEnvPrefix, injectEnvBeforeGit } from "./env.js";
import type { ExecFn } from "./exec.js";
import { formatGateReason, runSignGate } from "./gate.js";
import { resolveSigningKey } from "./keys.js";
import { PassfileRegistry } from "./passfile.js";
import { promptPassphrase } from "./prompt.js";
import { makeSessionState, type SessionState } from "./session-state.js";
import { ensureExecutable, resolveShim } from "./shim.js";
import { createGitCommitTool, isLikelyBadPassphrase } from "./tools/git-commit.js";
import { isTouchIdSupportedPlatform } from "./touchid.js";

type Severity = "ok" | "info" | "warning" | "error";

export default function piGpgExtension(pi: ExtensionAPI): void {
	const exec: ExecFn = async (command, args) => {
		const r = await pi.exec(command, [...args]);
		return { stdout: r.stdout, stderr: r.stderr, code: r.code ?? 0 };
	};

	// Session state starts as null; populated on session_start.
	let state: SessionState | null = null;

	// ------------------------------------------------------------------
	// session_start — bring up cache, shim, registries; run doctor.
	// ------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		try {
			const report = await runDoctor(exec, { cwd: ctx.cwd });

			// Load persistent pi-gpg config. Failure to load is non-fatal — we
			// start with defaults and surface a notify so the user can recover.
			const configStore = createFileConfigStore();
			let config: PiGpgConfig;
			try {
				config = await configStore.load();
			} catch (err) {
				ctx.ui.notify(`pi-gpg: ${errMsg(err)} — continuing with defaults.`, "warning");
				const { DEFAULT_CONFIG } = await import("./config.js");
				config = { ...DEFAULT_CONFIG };
			}

			// TTL resolution order: user override → gpg-agent.conf → built-in default.
			const ttlDefaultMs =
				config.idleTtlSeconds != null
					? config.idleTtlSeconds * 1000
					: (report.agentConf.defaultCacheTtl ?? DEFAULT_CACHE_TTL_MS / 1000) * 1000;
			const ttlMaxMs =
				config.maxTtlSeconds != null
					? config.maxTtlSeconds * 1000
					: (report.agentConf.maxCacheTtl ?? MAX_CACHE_TTL_MS / 1000) * 1000;
			const cache = new PassphraseCache({
				defaultCacheTtlMs: ttlDefaultMs,
				maxCacheTtlMs: ttlMaxMs,
			});
			const passfiles = new PassfileRegistry();

			const shim = await resolveShim();
			if (shim.exists) await ensureExecutable(shim.path);

			const canSign = Boolean(report.gpg.path) && report.keys.length > 0;

			state = makeSessionState({
				shimPath: shim.path,
				shimReady: shim.exists,
				cache,
				passfiles,
				canSign,
				config,
				configStore,
				...(report.gpg.path ? { realGpgPath: report.gpg.path } : {}),
			});

			// Register the tool now that we have state. The gateSupplier closes
			// over `state` so it always sees the latest config / confirmed-keys
			// set — users can flip the policy via `/gpg-config` mid-session and
			// the next `git_commit` honors it without a restart.
			pi.registerTool(
				createGitCommitTool({
					exec,
					cache,
					shimPath: shim.path,
					...(report.gpg.path ? { realGpgPath: report.gpg.path } : {}),
					gateSupplier: (_ctxArg, base) => {
						const s = state;
						if (!s) return null;
						return {
							config: s.config,
							confirmedKeys: s.confirmedKeys,
							...base,
						};
					},
				}),
			);

			// Subscribe to cache mutations so the toolbar auto-refreshes on
			// unlock, lock, successful git_commit, bad-passphrase invalidation,
			// and background TTL expiry — without every mutator knowing about
			// the status API. Retained in session state so `session_shutdown`
			// can tear it down cleanly.
			state.unsubscribeCacheStatus = cache.onChange(() => {
				if (state) updateStatus(ctx, state);
			});

			// Passive status indicator — initial paint. Subsequent updates flow
			// through the cache.onChange subscription above.
			updateStatus(ctx, state);

			if (!shim.exists) {
				ctx.ui.notify(
					`pi-gpg: shim not found at ${shim.path}. Reinstall the extension — signing tools are disabled.`,
					"error",
				);
				return;
			}

			const worst = highestSeverity(report.findings);
			if (worst === "error" || worst === "warning") {
				const titles = report.findings
					.filter((f) => f.severity === "error" || f.severity === "warning")
					.map((f) => `• ${f.title}`)
					.join("\n");
				ctx.ui.notify(`pi-gpg: ${titles}\nRun /gpg-doctor for details.`, worst === "error" ? "error" : "warning");
			}
		} catch (err) {
			ctx.ui.notify(`pi-gpg: doctor failed — ${errMsg(err)}`, "warning");
		}
	});

	// ------------------------------------------------------------------
	// session_shutdown — zero cache, sweep temp files, drop state.
	// ------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, _ctx) => {
		const s = state;
		state = null;
		if (!s) return;
		s.unsubscribeCacheStatus?.();
		s.cache.clear();
		s.cache.dispose();
		await s.passfiles.sweep();
		// Drain any pending cleanups that never received tool_result (defensive).
		const fns = Array.from(s.pendingCleanups.values());
		s.pendingCleanups.clear();
		await Promise.allSettled(fns.map((fn) => fn()));
	});

	// ------------------------------------------------------------------
	// tool_call hook — detect bash git signing, route through shim.
	// ------------------------------------------------------------------
	pi.on("tool_call", async (event, ctx) => {
		const s = state;
		if (!s?.shimReady || !s.canSign) return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;

		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;

		// Pull effective git config for decision making. Cheap (two exec calls).
		const cfg = await readSigningConfigSnapshot(exec, ctx.cwd);
		if (cfg.gpgFormat === "ssh") return undefined; // not our lane

		const analysis = analyzeCommand(command, cfg);
		if (!analysis.willSign) return undefined;

		// Figure out which key is in play. For multi-invocation commands we take
		// the first invocation's explicit key if any; otherwise resolve the
		// effective key from git config.
		const firstExplicitKey = analysis.invocations.find((i) => i.explicitKeyid)?.explicitKeyid;
		const key = await resolveSigningKey(exec, {
			cwd: ctx.cwd,
			...(firstExplicitKey ? { explicitKeyid: firstExplicitKey } : {}),
		});

		// Acquire passphrase (cache hit or prompt).
		let passphrase = s.cache.get(key.keyid);
		let fromCache = true;
		if (!passphrase) {
			fromCache = false;
			const result = await promptPassphrase(ctx, {
				title: "🔑 pi-gpg passphrase",
				placeholder: "passphrase",
				keyid: key.display,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
			if (!result.ok) {
				return {
					block: true,
					reason:
						result.reason === "no-ui"
							? "pi-gpg: passphrase not cached and no UI available. Run /gpg-unlock first."
							: "pi-gpg: passphrase entry cancelled.",
				};
			}
			passphrase = result.passphrase;
			// Warm the cache immediately so the bash tool reads it on retries,
			// and subsequent signing calls in the session skip the prompt.
			s.cache.put(key.keyid, passphrase);
		}

		// Run the sign-gate (Touch ID + confirm). Failure blocks the bash
		// command before we ever write the passfile — no shim spawn, no disk
		// exposure of anything beyond what was already in the cache.
		const subcommandsForGate = Array.from(new Set(analysis.invocations.map((i) => i.subcommand))).join(", ");
		const gateResult = await runSignGate(ctx, {
			config: s.config,
			confirmedKeys: s.confirmedKeys,
			keyid: key.keyid,
			keyDisplay: key.display,
			operation: `git ${subcommandsForGate}`,
			fromCache,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (!gateResult.ok) {
			passphrase.fill(0);
			return { block: true, reason: formatGateReason(gateResult) };
		}

		// Write to temp file for the shim to pick up.
		const handle = await s.passfiles.allocate(passphrase);

		// Zero our in-hand copy — the cache still holds a separate copy.
		passphrase.fill(0);

		// Build the env injection and rewrite the command.
		const envPrefix = buildBashEnvPrefix({
			shimPath: s.shimPath,
			passfilePath: handle.path,
			...(s.realGpgPath ? { realGpgPath: s.realGpgPath } : {}),
		});
		event.input.command = injectEnvBeforeGit(command, envPrefix);

		// Record cleanup tied to this tool call.
		s.pendingCleanups.set(event.toolCallId, () => handle.cleanup());

		// Tell the user (per project rule (c): rewrite + notify).
		const subcommands = Array.from(new Set(analysis.invocations.map((i) => i.subcommand))).join(", ");
		ctx.ui.notify(
			`pi-gpg: routing \`git ${subcommands}\` through loopback shim (key ${key.display}${fromCache ? ", cached" : ""}).`,
			"info",
		);
		// Status update is emitted by cache.onChange subscriber — no manual call needed.

		return undefined;
	});

	// Drain the bash route's temp file as soon as the tool completes. We also
	// inspect the result for signing failures: if gpg rejected the passphrase we
	// clear the cache so the *next* bash `git commit -S` invocation re-prompts
	// fresh, mirroring pinentry's "try again" behavior across retries.
	pi.on("tool_result", async (event, ctx) => {
		const s = state;
		if (!s) return;
		const cleanup = s.pendingCleanups.get(event.toolCallId);
		if (!cleanup) return;
		s.pendingCleanups.delete(event.toolCallId);
		try {
			if (looksLikeBashSignFailure(event)) {
				const invalidated = invalidateAllCacheEntries(s);
				if (invalidated > 0) {
					ctx.ui.notify(
						`pi-gpg: signing failed in bash — cleared ${invalidated} cached passphrase${
							invalidated === 1 ? "" : "s"
						}. The next \`git commit -S\` will re-prompt.`,
						"warning",
					);
					// Toolbar refresh happens via cache.onChange subscriber.
				}
			}
		} finally {
			await cleanup();
		}
	});

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------
	pi.registerCommand("gpg-doctor", {
		description: "Inspect GPG / git-signing environment and report issues.",
		handler: async (_args, ctx) => {
			const report = await runDoctor(exec, { cwd: ctx.cwd });
			ctx.ui.notify(renderReport(report), highestSeverity(report.findings) === "error" ? "error" : "info");
		},
	});

	pi.registerCommand("gpg-status", {
		description: "Show pi-gpg cache state and signing key.",
		handler: async (_args, ctx) => {
			const s = state;
			if (!s) {
				ctx.ui.notify("pi-gpg: no session state.", "warning");
				return;
			}
			const lines: string[] = [];
			lines.push(`shim:       ${s.shimPath} ${s.shimReady ? "✓" : "(missing)"}`);
			lines.push(`can sign:   ${s.canSign ? "yes" : "no"}`);
			const stats = s.cache.stats();
			lines.push(
				`cache ttl:  idle ${Math.round(s.cache.defaultCacheTtlMs / 1000)}s · max ${Math.round(
					s.cache.maxCacheTtlMs / 1000,
				)}s`,
			);
			if (stats.size === 0) {
				lines.push("cache:      🔒 locked (0 entries)");
			} else {
				lines.push(`cache:      🔓 unlocked (${stats.size} entr${stats.size === 1 ? "y" : "ies"})`);
				for (const e of stats.entries) {
					lines.push(`              · ${e.keyid}  (${PassphraseCache.formatRemaining(e)} remaining)`);
				}
			}
			lines.push(`live temp passfiles: ${s.passfiles.liveCount}`);
			lines.push("");
			for (const line of describeConfig(s.config)) lines.push(line);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ------------------------------------------------------------------
	// /gpg-config — interactive editor for confirm / Touch ID / TTL / key
	// ------------------------------------------------------------------
	pi.registerCommand("gpg-config", {
		description: "Edit pi-gpg settings: signing key, confirm policy, cache TTLs, Touch ID gating.",
		handler: async (_args, ctx) => {
			const s = state;
			if (!s) {
				ctx.ui.notify("pi-gpg: no session state; is the extension loaded?", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("pi-gpg: /gpg-config requires interactive mode.", "warning");
				return;
			}
			await runGpgConfigMenu(ctx, s, exec);
		},
	});

	pi.registerCommand("gpg-unlock", {
		description: "Prompt for passphrase and pre-populate the cache for this session.",
		handler: async (_args, ctx) => {
			const s = state;
			if (!s) {
				ctx.ui.notify("pi-gpg: no session state; is the extension loaded?", "error");
				return;
			}
			const key = await resolveSigningKey(exec, { cwd: ctx.cwd });
			const result = await promptPassphrase(ctx, {
				title: "🔑 pi-gpg unlock",
				placeholder: "passphrase",
				keyid: key.display,
			});
			if (!result.ok) {
				ctx.ui.notify(`pi-gpg: unlock ${result.reason}.`, "warning");
				return;
			}
			s.cache.put(key.keyid, result.passphrase);
			result.passphrase.fill(0);
			ctx.ui.notify(`pi-gpg: 🔓 unlocked key ${key.display}.`, "info");
			// Toolbar refresh happens via cache.onChange subscriber.
		},
	});

	pi.registerCommand("gpg-lock", {
		description: "Zero the passphrase cache immediately.",
		handler: async (_args, ctx) => {
			const s = state;
			if (!s) return;
			const count = s.cache.stats().size;
			s.cache.clear();
			ctx.ui.notify(`pi-gpg: 🔒 locked (${count} entr${count === 1 ? "y" : "ies"} zeroized).`, "info");
			// Toolbar refresh happens via cache.onChange subscriber.
		},
	});
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function updateStatus(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1], s: SessionState): void {
	const count = s.cache.stats().size;
	const label = count === 0 ? "🔒 locked" : `🔓 ${count} key${count === 1 ? "" : "s"}`;
	ctx.ui.setStatus("pi-gpg", `pi-gpg ${label}`);
}

function highestSeverity(findings: readonly { severity: Severity }[]): Severity {
	const rank: Record<Severity, number> = { ok: 0, info: 1, warning: 2, error: 3 };
	let worst: Severity = "ok";
	for (const f of findings) {
		if (rank[f.severity] > rank[worst]) worst = f.severity;
	}
	return worst;
}

async function readSigningConfigSnapshot(exec: ExecFn, cwd: string): Promise<GitSigningConfigSnapshot> {
	const out: GitSigningConfigSnapshot = {};

	const get = async (scope: "local" | "global", key: string) => {
		const args =
			scope === "local" ? ["-C", cwd, "config", "--local", "--get", key] : ["config", "--global", "--get", key];
		const r = await exec("git", args);
		return r.code === 0 ? r.stdout.trim() : "";
	};

	for (const scope of ["global", "local"] as const) {
		const [commit, tag, signingKey, format] = await Promise.all([
			get(scope, "commit.gpgsign"),
			get(scope, "tag.gpgsign"),
			get(scope, "user.signingkey"),
			get(scope, "gpg.format"),
		]);
		if (commit === "true") out.commitGpgsign = true;
		else if (commit === "false") out.commitGpgsign = false;
		if (tag === "true") out.tagGpgsign = true;
		else if (tag === "false") out.tagGpgsign = false;
		if (signingKey) out.userSigningKey = signingKey;
		if (format) out.gpgFormat = format;
	}
	return out;
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Best-effort inspection of a bash tool_result. Pi's result shapes differ across
 * versions, so we poke at a few common fields and collapse anything that smells
 * like a signing failure into one combined string for the detector.
 */
function looksLikeBashSignFailure(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const e = event as Record<string, unknown>;

	// Some runners surface tool errors on a boolean flag; always inspect the
	// output regardless since success + signing-failure-in-output is possible
	// when the bash command is `git ... && foo` or similar.
	const pieces: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === "string") pieces.push(v);
	};

	push(e.stdout);
	push(e.stderr);
	push(e.output);
	push(e.error);

	const result = e.result as Record<string, unknown> | undefined;
	if (result) {
		push(result.stdout);
		push(result.stderr);
		push(result.output);
		const content = result.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				if (item && typeof item === "object" && "text" in item) push((item as Record<string, unknown>).text);
			}
		}
	}

	const content = e.content;
	if (Array.isArray(content)) {
		for (const item of content) {
			if (item && typeof item === "object" && "text" in item) push((item as Record<string, unknown>).text);
		}
	}

	if (pieces.length === 0) return false;
	return isLikelyBadPassphrase(pieces.join("\n"));
}

/**
 * Zero every entry in the cache. Used when a bash signing attempt fails and we
 * don't know which specific keyid it was targeting (the event doesn't always
 * carry the signing key). Scope is per-session so this is at most a handful
 * of entries.
 */
function invalidateAllCacheEntries(s: SessionState): number {
	const stats = s.cache.stats();
	for (const entry of stats.entries) s.cache.invalidate(entry.keyid);
	return stats.size;
}

// ---------------------------------------------------------------------------
// /gpg-config interactive menu
// ---------------------------------------------------------------------------

/**
 * Top-level menu loop. Each iteration paints the current settings, offers a
 * fixed set of actions, then dispatches. Exits on "Done" or Esc.
 *
 * Changes take effect immediately where reasonable (confirm policy, Touch
 * ID toggle). TTL changes require notifying the user they apply on next
 * session because resizing a live cache's TTLs mid-flight has surprising
 * interactions with already-running expiry timers.
 */
async function runGpgConfigMenu(ctx: ExtensionContext, s: SessionState, exec: ExecFn): Promise<void> {
	const DONE = "✓ Done";

	// Loop until the user selects Done / cancels.
	// Safety net: cap iterations so a bug can't spin a user's terminal.
	for (let i = 0; i < 50; i++) {
		const currentKeyLine = await describeEffectiveKey(exec, ctx.cwd);
		const options = [
			`Signing key:      ${currentKeyLine}`,
			`Confirm policy:   ${s.config.confirmPolicy}`,
			`Touch ID gating:  ${s.config.touchIdGating ? "on" : "off"}${
				isTouchIdSupportedPlatform() ? "" : " (unsupported platform)"
			}`,
			`Idle TTL:         ${s.config.idleTtlSeconds != null ? `${s.config.idleTtlSeconds}s` : "(inherit)"}`,
			`Max TTL:          ${s.config.maxTtlSeconds != null ? `${s.config.maxTtlSeconds}s` : "(inherit)"}`,
			DONE,
		];

		const choice = await ctx.ui.select("pi-gpg settings — choose what to edit", options);
		if (!choice || choice === DONE) return;

		if (choice.startsWith("Signing key:")) {
			await editSigningKey(ctx, exec);
		} else if (choice.startsWith("Confirm policy:")) {
			await editConfirmPolicy(ctx, s);
		} else if (choice.startsWith("Touch ID gating:")) {
			await editTouchIdGating(ctx, s);
		} else if (choice.startsWith("Idle TTL:")) {
			await editTtl(ctx, s, "idle");
		} else if (choice.startsWith("Max TTL:")) {
			await editTtl(ctx, s, "max");
		}
	}
}

async function describeEffectiveKey(exec: ExecFn, cwd: string): Promise<string> {
	try {
		const resolved = await resolveSigningKey(exec, { cwd });
		return resolved.explicit ? resolved.display : "(gpg default)";
	} catch {
		return "(unknown)";
	}
}

/**
 * Let the user pick a secret key and optionally write it back to
 * `git config --global user.signingkey`. We don't rewrite repo-local
 * config — too much risk of surprising a shared workspace.
 */
async function editSigningKey(ctx: ExtensionContext, exec: ExecFn): Promise<void> {
	const report = await runDoctor(exec, { cwd: ctx.cwd });
	if (report.keys.length === 0) {
		ctx.ui.notify("pi-gpg: no secret keys found in GNUPGHOME.", "warning");
		return;
	}

	const options = report.keys.map((k) => formatKeyOption(k));
	options.push("← Cancel");
	const choice = await ctx.ui.select("Pick a signing key", options);
	if (!choice || choice.startsWith("←")) return;

	const picked = report.keys.find((k) => formatKeyOption(k) === choice);
	if (!picked) return;

	const ok = await ctx.ui.confirm(
		"Set as global signing key?",
		`This will run: git config --global user.signingkey ${picked.keyid}\n\nAffects every repo on this machine that doesn't override user.signingkey locally.`,
	);
	if (!ok) return;

	const r = await exec("git", ["config", "--global", "user.signingkey", picked.keyid]);
	if (r.code !== 0) {
		ctx.ui.notify(`pi-gpg: git config failed — ${r.stderr.trim() || r.stdout.trim()}`, "error");
		return;
	}
	ctx.ui.notify(`pi-gpg: user.signingkey → ${picked.keyid}.`, "info");
}

function formatKeyOption(k: SecretKey): string {
	const uid = k.uids[0] ?? "(no uid)";
	const exp = k.expired ? " ⚠ expired" : k.expires ? ` (expires ${k.expires.slice(0, 10)})` : "";
	return `${k.keyid}  — ${uid}${exp}`;
}

async function editConfirmPolicy(ctx: ExtensionContext, s: SessionState): Promise<void> {
	const options = [
		`always${s.config.confirmPolicy === "always" ? "  ✓" : ""}`,
		`first-in-session${s.config.confirmPolicy === "first-in-session" ? "  ✓" : ""}`,
		`never${s.config.confirmPolicy === "never" ? "  ✓" : ""}`,
		"← Cancel",
	];
	const choice = await ctx.ui.select("Per-commit confirm policy", options);
	if (!choice || choice.startsWith("←")) return;

	const picked = choice.startsWith("always")
		? "always"
		: choice.startsWith("first-in-session")
			? "first-in-session"
			: "never";

	s.config.confirmPolicy = picked;
	// Switching policy mid-session clears the remembered confirmed set — the
	// user is asking us to re-evaluate, so make it obvious.
	s.confirmedKeys.clear();
	await persistConfig(ctx, s);
	ctx.ui.notify(`pi-gpg: confirm policy → ${picked}.`, "info");
}

async function editTouchIdGating(ctx: ExtensionContext, s: SessionState): Promise<void> {
	if (!isTouchIdSupportedPlatform()) {
		ctx.ui.notify(
			`pi-gpg: Touch ID gating isn't supported on ${process.platform}. Leaving ${s.config.touchIdGating ? "on (no-op)" : "off"}.`,
			"warning",
		);
		return;
	}
	const options = [
		`on${s.config.touchIdGating ? "  ✓" : ""}`,
		`off${s.config.touchIdGating ? "" : "  ✓"}`,
		"← Cancel",
	];
	const choice = await ctx.ui.select("Touch ID gating", options);
	if (!choice || choice.startsWith("←")) return;

	const desired = choice.startsWith("on");
	if (desired === s.config.touchIdGating) return;
	s.config.touchIdGating = desired;
	await persistConfig(ctx, s);
	ctx.ui.notify(
		desired
			? "pi-gpg: Touch ID gating → on. You'll be prompted before releasing any cached passphrase."
			: "pi-gpg: Touch ID gating → off.",
		"info",
	);
}

async function editTtl(ctx: ExtensionContext, s: SessionState, kind: "idle" | "max"): Promise<void> {
	const field: "idleTtlSeconds" | "maxTtlSeconds" = kind === "idle" ? "idleTtlSeconds" : "maxTtlSeconds";
	const current = s.config[field];
	const label = kind === "idle" ? "Idle TTL (seconds, or blank to inherit)" : "Max TTL (seconds, or blank to inherit)";
	const raw = await ctx.ui.input(label, current != null ? String(current) : "");
	if (raw === undefined) return; // cancelled

	const trimmed = raw.trim();
	if (trimmed === "") {
		delete s.config[field];
	} else {
		const parsed = Number.parseInt(trimmed, 10);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			ctx.ui.notify("pi-gpg: TTL must be a positive integer.", "warning");
			return;
		}
		s.config[field] = parsed;
	}

	await persistConfig(ctx, s);
	ctx.ui.notify(
		`pi-gpg: ${kind} TTL → ${s.config[field] != null ? `${s.config[field]}s` : "(inherit)"} (applies on next session).`,
		"info",
	);
}

async function persistConfig(ctx: ExtensionContext, s: SessionState): Promise<void> {
	try {
		await s.configStore.save(s.config);
	} catch (err) {
		ctx.ui.notify(`pi-gpg: failed to persist config — ${errMsg(err)}`, "error");
	}
}

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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS, PassphraseCache } from "./cache.js";
import { analyzeCommand, type GitSigningConfigSnapshot } from "./detect.js";
import { renderReport, runDoctor } from "./doctor.js";
import { buildBashEnvPrefix, injectEnvBeforeGit } from "./env.js";
import type { ExecFn } from "./exec.js";
import { resolveSigningKey } from "./keys.js";
import { PassfileRegistry } from "./passfile.js";
import { promptPassphrase } from "./prompt.js";
import { makeSessionState, type SessionState } from "./session-state.js";
import { ensureExecutable, resolveShim } from "./shim.js";
import { createGitCommitTool } from "./tools/git-commit.js";

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

			const ttlDefaultMs = (report.agentConf.defaultCacheTtl ?? DEFAULT_CACHE_TTL_MS / 1000) * 1000;
			const ttlMaxMs = (report.agentConf.maxCacheTtl ?? MAX_CACHE_TTL_MS / 1000) * 1000;
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
				...(report.gpg.path ? { realGpgPath: report.gpg.path } : {}),
			});

			// Register the tool now that we have state.
			pi.registerTool(
				createGitCommitTool({
					exec,
					cache,
					shimPath: shim.path,
					...(report.gpg.path ? { realGpgPath: report.gpg.path } : {}),
				}),
			);

			// Passive status indicator. Refreshed on unlock/lock.
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
		s.cache.clear();
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
		updateStatus(ctx, s);

		return undefined;
	});

	// Drain the bash route's temp file as soon as the tool completes.
	pi.on("tool_result", async (event, _ctx) => {
		const s = state;
		if (!s) return;
		const cleanup = s.pendingCleanups.get(event.toolCallId);
		if (!cleanup) return;
		s.pendingCleanups.delete(event.toolCallId);
		await cleanup();
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
			ctx.ui.notify(lines.join("\n"), "info");
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
			updateStatus(ctx, s);
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
			updateStatus(ctx, s);
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

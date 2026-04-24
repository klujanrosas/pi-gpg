/**
 * `git_commit` — first-class Pi tool for making signed commits without
 * invoking pinentry. This is the preferred path; the LLM is nudged toward it
 * via `promptGuidelines`, and the bash interceptor redirects raw
 * `git commit -S ...` here when the shape matches.
 */

import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { PassphraseCache } from "../cache.js";
import type { ExecFn } from "../exec.js";
import { runGitWithFd3Passphrase, zeroize } from "../gpg.js";
import { resolveSigningKey } from "../keys.js";
import { promptPassphrase } from "../prompt.js";

export const GitCommitInputSchema = Type.Object({
	message: Type.String({
		description: "Commit message. Required. Multiple `-m` is not supported; use a multi-line string.",
	}),
	all: Type.Optional(Type.Boolean({ description: "Stage modified+deleted tracked files (git commit -a)." })),
	amend: Type.Optional(
		Type.Boolean({ description: "Replace the tip of the current branch with a new commit (git commit --amend)." }),
	),
	allowEmpty: Type.Optional(
		Type.Boolean({ description: "Allow a commit with no changes (git commit --allow-empty)." }),
	),
	noVerify: Type.Optional(
		Type.Boolean({ description: "Skip pre-commit and commit-msg hooks (git commit --no-verify)." }),
	),
	signoff: Type.Optional(Type.Boolean({ description: "Add Signed-off-by trailer." })),
	keyid: Type.Optional(
		Type.String({ description: "Override the signing key. Defaults to user.signingkey from git config." }),
	),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Limit commit to these paths." })),
});
export type GitCommitInput = Static<typeof GitCommitInputSchema>;

export interface GitCommitToolDeps {
	exec: ExecFn;
	cache: PassphraseCache;
	shimPath: string;
	realGpgPath?: string;
}

export function createGitCommitTool(deps: GitCommitToolDeps): ToolDefinition<typeof GitCommitInputSchema> {
	return {
		name: "git_commit",
		label: "Signed git commit",
		description:
			"Create a signed git commit without invoking pinentry. Routes GPG passphrase through Pi's UI and keeps the TTY clean. " +
			"Always use this tool for signed commits; never run `git commit -S` through the bash tool.",
		promptSnippet: "Make a signed git commit (TTY-safe, agent-friendly).",
		promptGuidelines: [
			"Use git_commit instead of `git commit` whenever signing is involved — including when commit.gpgsign is enabled globally.",
			"git_commit makes exactly one commit; stage files first with the bash tool if needed (git add ...).",
		],
		parameters: GitCommitInputSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const message = (params.message ?? "").trim();
			if (message.length === 0) {
				throw new Error("git_commit: `message` is required and must be non-empty.");
			}

			const key = await resolveSigningKey(deps.exec, {
				cwd: ctx.cwd,
				explicitKeyid: params.keyid,
			});

			// Resolve passphrase — cache hit, else prompt, else fail cleanly.
			let passphrase = deps.cache.get(key.keyid);
			let fromCache = true;
			if (!passphrase) {
				fromCache = false;
				const result = await promptPassphrase(ctx, {
					title: "🔑 pi-gpg passphrase",
					placeholder: "passphrase",
					keyid: key.display,
					...(signal ? { signal } : {}),
				});
				if (!result.ok) {
					const reasonText =
						result.reason === "no-ui"
							? "Passphrase not cached and no UI available. Run /gpg-unlock in interactive mode first, or enable key caching in your environment."
							: "Passphrase entry cancelled by user.";
					throw new Error(`git_commit: ${reasonText}`);
				}
				passphrase = result.passphrase;
			}

			onUpdate?.({
				content: [{ type: "text", text: `Signing with key ${key.display}${fromCache ? " (cached)" : ""}…` }],
				details: {},
			});

			const args: string[] = ["commit", "-S", "-m", message];
			if (params.keyid) {
				// Re-pass the keyid to git so it matches what we resolved (handles
				// the case where explicit keyid differs from user.signingkey).
				args.splice(1, 0, `-S${params.keyid}`);
				args.splice(2, 1); // drop the original -S since we merged it
			}
			if (params.all) args.push("-a");
			if (params.amend) args.push("--amend");
			if (params.allowEmpty) args.push("--allow-empty");
			if (params.noVerify) args.push("--no-verify");
			if (params.signoff) args.push("--signoff");
			// --no-edit keeps us out of the editor path since we always supply -m.
			args.push("--no-edit");
			if (params.paths && params.paths.length > 0) {
				args.push("--", ...params.paths);
			}

			const gitOpts: Parameters<typeof runGitWithFd3Passphrase>[0] = {
				args,
				shimPath: deps.shimPath,
				cwd: ctx.cwd,
				passphrase,
				onStdout: (s) => onUpdate?.({ content: [{ type: "text", text: s }], details: {} }),
				onStderr: (s) => onUpdate?.({ content: [{ type: "text", text: s }], details: {} }),
			};
			if (signal) gitOpts.signal = signal;
			if (deps.realGpgPath) gitOpts.realGpgPath = deps.realGpgPath;

			const { code, stdout, stderr } = await runGitWithFd3Passphrase(gitOpts);

			// Cache write-through (only after a successful sign) so subsequent
			// commits in this session don't re-prompt.
			if (code === 0 && !fromCache) {
				deps.cache.put(key.keyid, passphrase);
			} else if (code !== 0 && !fromCache) {
				// Bad passphrase or other sign error — don't poison the cache.
			}

			// Zeroize our in-hand copy after spawn has written it to the pipe.
			zeroize(passphrase);

			if (code !== 0) {
				const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
				const looksLikeBadPassphrase = /bad passphrase|passphrase is incorrect/i.test(combined);
				if (looksLikeBadPassphrase) {
					deps.cache.invalidate(key.keyid);
				}
				throw new Error(
					looksLikeBadPassphrase
						? `git_commit: bad passphrase for key ${key.display}. Cache cleared; try again.`
						: `git_commit: git exited ${code}.\n${combined}`,
				);
			}

			const summary = summarizeCommit(stdout, stderr);

			return {
				content: [{ type: "text", text: summary || stdout || stderr || "(no output)" }],
				details: {
					subcommand: "commit",
					keyid: key.keyid,
					keyidDisplay: key.display,
					fromCache,
					summary,
					stdout,
					stderr,
				},
			};
		},
	};
}

/** Extract the compact `[branch sha] subject` line if present. */
function summarizeCommit(stdout: string, stderr: string): string {
	const combined = `${stdout}\n${stderr}`;
	const match = combined.match(/^\[[^\]]+\]\s.+$/m);
	return match?.[0] ?? stdout.trim().split(/\r?\n/)[0] ?? "";
}

export function registerGitCommitTool(pi: ExtensionAPI, deps: GitCommitToolDeps): void {
	pi.registerTool(createGitCommitTool(deps));
}

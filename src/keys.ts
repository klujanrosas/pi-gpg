/**
 * Resolve which signing key should be used for an operation, and build a
 * stable cache key from it.
 *
 * Resolution order (first hit wins):
 *   1. Explicit `keyid` passed by the caller (e.g. `-S KEY` on the command line).
 *   2. `user.signingkey` in git config (repo > global).
 *   3. `__default__` sentinel — gpg picks its default secret key.
 */

import type { ExecFn } from "./exec.js";

export interface ResolvedKey {
	/** Full keyid/fingerprint used for selection, or `__default__`. */
	keyid: string;
	/** `true` when a specific key was found; `false` for the default sentinel. */
	explicit: boolean;
	/** Short (last 16 chars) form for display. */
	display: string;
}

export async function resolveSigningKey(
	exec: ExecFn,
	opts: { cwd: string; explicitKeyid?: string },
): Promise<ResolvedKey> {
	if (opts.explicitKeyid && opts.explicitKeyid.length > 0) {
		return format(opts.explicitKeyid, true);
	}
	// Repo first, then global.
	const repo = await exec("git", ["-C", opts.cwd, "config", "--local", "--get", "user.signingkey"]);
	if (repo.code === 0 && repo.stdout.trim()) return format(repo.stdout.trim(), true);

	const global = await exec("git", ["config", "--global", "--get", "user.signingkey"]);
	if (global.code === 0 && global.stdout.trim()) return format(global.stdout.trim(), true);

	return { keyid: "__default__", explicit: false, display: "default" };
}

function format(keyid: string, explicit: boolean): ResolvedKey {
	const cleaned = keyid.replace(/^0x/i, "");
	return {
		keyid: cleaned,
		explicit,
		display: cleaned.length > 16 ? cleaned.slice(-16) : cleaned,
	};
}

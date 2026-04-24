/**
 * Per-commit confirmation gate.
 *
 * Before releasing a passphrase for a signing operation, optionally block on
 * a user confirmation dialog. Policy is sourced from the persistent config;
 * call sites supply the operation details (subject, keyid, whether we're
 * about to release a cached entry vs. freshly prompted).
 *
 * The three policies and their behavior:
 *
 *   "never"
 *     Always allow. No dialog. Passphrase flow is unchanged from Phase 1.
 *
 *   "always"
 *     Prompt every time, even on cache hits. Used by people who want the
 *     strongest user-presence signal short of Touch ID.
 *
 *   "first-in-session"  (default)
 *     Prompt once per (session, keyid). Subsequent signings within the same
 *     session for the same key proceed without prompting. The per-key set
 *     lives on the SessionState.
 *
 * The confirm dialog itself uses `ctx.ui.confirm` — a built-in Pi primitive
 * available in every interactive mode. If there's no UI (`hasUI === false`),
 * `first-in-session` and `always` both reject — we will not sign without
 * explicit user presence when the policy asked for it.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ConfirmPolicy } from "./config.js";

/** Set of keyids that have already been confirmed in the current session. */
export type ConfirmedKeySet = Set<string>;

export interface ConfirmRequest {
	/** Confirm policy from the effective config. */
	policy: ConfirmPolicy;
	/** Resolved keyid (may be the `__default__` sentinel). */
	keyid: string;
	/** Short display form for the user (e.g. `ABCD1234DEADBEEF`). */
	keyDisplay: string;
	/** The git subcommand or tool surface initiating the sign. */
	operation: string;
	/** First line of the commit message, if we have one. Truncated for display. */
	subject?: string;
	/** Per-session set; will be mutated on successful confirmation. */
	session: ConfirmedKeySet;
	/** AbortSignal for cancellation. */
	signal?: AbortSignal;
}

export type ConfirmResult = { ok: true; skipped: boolean } | { ok: false; reason: "denied" | "no-ui" | "cancelled" };

/**
 * Apply the configured confirm policy. Returns `{ ok: true }` when signing
 * may proceed. `skipped` is true when the policy didn't require a prompt
 * (either `never` or a cached "first-in-session" hit).
 */
export async function confirmCommit(ctx: ExtensionContext, req: ConfirmRequest): Promise<ConfirmResult> {
	if (req.policy === "never") return { ok: true, skipped: true };

	if (req.policy === "first-in-session" && req.session.has(req.keyid)) {
		return { ok: true, skipped: true };
	}

	// We need a prompt. Without a UI, fail closed — the user explicitly asked
	// to be asked; silently bypassing would violate that intent.
	if (!ctx.hasUI) return { ok: false, reason: "no-ui" };

	const title = buildTitle(req);
	const message = buildMessage(req);

	try {
		const confirmed = await ctx.ui.confirm(title, message, {
			...(req.signal ? { signal: req.signal } : {}),
		});
		if (!confirmed) return { ok: false, reason: "denied" };
	} catch (err) {
		if (req.signal?.aborted) return { ok: false, reason: "cancelled" };
		throw err;
	}

	if (req.policy === "first-in-session") {
		req.session.add(req.keyid);
	}
	return { ok: true, skipped: false };
}

function buildTitle(req: ConfirmRequest): string {
	return `🔏 pi-gpg: sign with ${req.keyDisplay}?`;
}

function buildMessage(req: ConfirmRequest): string {
	const lines: string[] = [];
	lines.push(`operation: ${req.operation}`);
	if (req.subject) {
		const trimmed = req.subject.trim();
		const shown = trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
		lines.push(`subject:   ${shown}`);
	}
	if (req.policy === "first-in-session") {
		lines.push("");
		lines.push("(You will not be asked again for this key in this session.)");
	}
	return lines.join("\n");
}

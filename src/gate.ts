/**
 * Sign-gate: the pre-signing user-presence check shared by the `git_commit`
 * tool path and the bash interception path.
 *
 * Composes two independent gates in a fixed order:
 *
 *   1. Touch ID (macOS) — only when config enabled AND we're about to
 *      release an *already-cached* passphrase. Fresh prompts are themselves
 *      strong user-presence signals, so we don't double-prompt.
 *
 *   2. Per-commit confirm — policy lookup + dialog via `ctx.ui.confirm`.
 *      Always runs (subject to policy) so the user sees *what* will be
 *      signed and can back out.
 *
 * Returns a single outcome shared by both call sites so they can format the
 * error message once.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { PiGpgConfig } from "./config.js";
import { type ConfirmedKeySet, confirmCommit } from "./confirm.js";
import { authenticateTouchId, isTouchIdSupportedPlatform } from "./touchid.js";

export interface SignGateRequest {
	/** Effective config for this session. */
	config: PiGpgConfig;
	/** Per-session set tracking keys already OK'd. Will be mutated. */
	confirmedKeys: ConfirmedKeySet;
	/** The key being used to sign. */
	keyid: string;
	/** Short display form (e.g. `ABCD1234DEADBEEF`). */
	keyDisplay: string;
	/** Surface initiating the sign — e.g. `git_commit`, `git commit`, `git tag`. */
	operation: string;
	/** Subject line (first line) of the commit message, if known. */
	subject?: string;
	/** Whether we're about to release a cached passphrase (vs. freshly prompting). */
	fromCache: boolean;
	/** AbortSignal from the agent turn. */
	signal?: AbortSignal;
}

export type SignGateResult =
	| { ok: true }
	| {
			ok: false;
			reason: "touchid-denied" | "touchid-unavailable" | "confirm-denied" | "confirm-no-ui";
			detail?: string;
	  };

/**
 * Run every enabled gate in order and produce a single pass/fail. Emits
 * warning notifications for transitional failures (Touch ID unavailable
 * when explicitly enabled) so the user understands why we're blocking.
 */
export async function runSignGate(ctx: ExtensionContext, req: SignGateRequest): Promise<SignGateResult> {
	// Touch ID first — only when enabled, supported, and we're reusing cache.
	if (req.config.touchIdGating && req.fromCache) {
		if (!isTouchIdSupportedPlatform()) {
			// Unsupported platform but gating was requested — fail closed. This
			// is intentional: gating was opted in.
			ctx.ui.notify(
				`pi-gpg: Touch ID gating is enabled but this platform (${process.platform}) doesn't support it.`,
				"warning",
			);
			return { ok: false, reason: "touchid-unavailable", detail: `platform=${process.platform}` };
		}

		const reason = `Release pi-gpg cached passphrase for ${req.keyDisplay}`;
		const outcome = await authenticateTouchId(reason);
		if (!outcome.ok) {
			if (outcome.reason === "unavailable") {
				ctx.ui.notify(`pi-gpg: Touch ID unavailable — ${outcome.detail ?? "unknown"}.`, "warning");
				return { ok: false, reason: "touchid-unavailable", detail: outcome.detail ?? "" };
			}
			return { ok: false, reason: "touchid-denied", detail: outcome.detail ?? "" };
		}
	}

	// Confirm policy second.
	const confirmOutcome = await confirmCommit(ctx, {
		policy: req.config.confirmPolicy,
		keyid: req.keyid,
		keyDisplay: req.keyDisplay,
		operation: req.operation,
		...(req.subject ? { subject: req.subject } : {}),
		session: req.confirmedKeys,
		...(req.signal ? { signal: req.signal } : {}),
	});

	if (!confirmOutcome.ok) {
		if (confirmOutcome.reason === "no-ui") return { ok: false, reason: "confirm-no-ui" };
		return { ok: false, reason: "confirm-denied" };
	}

	return { ok: true };
}

/**
 * Map a gate failure to a user-facing block reason string. Centralized so
 * the tool path and bash path speak with the same voice.
 */
export function formatGateReason(result: Extract<SignGateResult, { ok: false }>): string {
	switch (result.reason) {
		case "touchid-denied":
			return "pi-gpg: Touch ID check was denied.";
		case "touchid-unavailable":
			return `pi-gpg: Touch ID is required by config but unavailable${result.detail ? ` (${result.detail})` : ""}.`;
		case "confirm-denied":
			return "pi-gpg: commit signing cancelled at confirm dialog.";
		case "confirm-no-ui":
			return "pi-gpg: confirm policy requires a UI prompt, but no UI is available. Adjust `/gpg-config` or run interactively.";
	}
}

/**
 * Passphrase prompt wrapper.
 *
 * v0.1.0 uses `ctx.ui.input()` — unmasked. The user's terminal history may
 * briefly show the typed characters before the dialog dismisses; this is not
 * acceptable long-term.
 *
 * Phase 2 TODO: replace with a `ctx.ui.custom()` component backed by a masked
 * variant of `@mariozechner/pi-tui`'s Input class.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PromptRequest {
	title: string;
	placeholder?: string;
	keyid?: string;
	/** Aborts the prompt if signalled. */
	signal?: AbortSignal;
}

export type PromptResult = { ok: true; passphrase: Buffer } | { ok: false; reason: "cancelled" | "no-ui" | "timeout" };

export async function promptPassphrase(ctx: ExtensionContext, req: PromptRequest): Promise<PromptResult> {
	if (!ctx.hasUI) {
		return { ok: false, reason: "no-ui" };
	}

	const title = req.keyid ? `${req.title} (key ${shortKey(req.keyid)})` : req.title;
	let value: string | undefined;
	try {
		value = await ctx.ui.input(title, req.placeholder ?? "passphrase", {
			...(req.signal ? { signal: req.signal } : {}),
		});
	} catch (err) {
		if (req.signal?.aborted) return { ok: false, reason: "cancelled" };
		throw err;
	}

	if (value === undefined) {
		return { ok: false, reason: req.signal?.aborted ? "cancelled" : "cancelled" };
	}
	if (value.length === 0) {
		return { ok: false, reason: "cancelled" };
	}

	// Encode to Buffer so downstream callers can zero it.
	const buf = Buffer.from(value, "utf8");
	// Best-effort hygiene: overwrite the string reference. JS engines may still
	// retain copies; see the threat model note in README.
	value = "\0".repeat(value.length);
	return { ok: true, passphrase: buf };
}

function shortKey(keyid: string): string {
	if (keyid.length <= 16) return keyid;
	return `${keyid.slice(0, 8)}…${keyid.slice(-8)}`;
}

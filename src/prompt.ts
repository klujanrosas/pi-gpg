/**
 * Passphrase prompt wrapper.
 *
 * Phase 2: prefers a masked overlay via `ctx.ui.custom()` (renders `•` per
 * character, never the real glyph). Falls back to the unmasked
 * `ctx.ui.input()` dialog when `ctx.ui.custom` is unavailable — RPC / print
 * transports still pass through this path, and some unit tests stub only
 * the minimal `input` surface.
 *
 * The masked path is the default for interactive sessions; the fallback is
 * kept so no environment silently loses the ability to type a passphrase.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promptPassphraseMasked } from "./ui/masked-prompt.js";

export interface PromptRequest {
	title: string;
	placeholder?: string;
	keyid?: string;
	/** Aborts the prompt if signalled. */
	signal?: AbortSignal;
	/**
	 * Force the legacy unmasked `ctx.ui.input()` path even when an overlay is
	 * available. Intended for environments that can't render overlays; most
	 * callers should leave this unset.
	 */
	forceUnmasked?: boolean;
}

export type PromptResult = { ok: true; passphrase: Buffer } | { ok: false; reason: "cancelled" | "no-ui" | "timeout" };

export async function promptPassphrase(ctx: ExtensionContext, req: PromptRequest): Promise<PromptResult> {
	if (!ctx.hasUI) {
		return { ok: false, reason: "no-ui" };
	}

	const title = req.keyid ? `${req.title} (key ${shortKey(req.keyid)})` : req.title;

	// Try the masked overlay first unless the caller forced the fallback.
	if (!req.forceUnmasked) {
		const masked = await promptPassphraseMasked(ctx, {
			title,
			...(req.keyid ? { keyid: shortKey(req.keyid) } : {}),
			...(req.signal ? { signal: req.signal } : {}),
		});
		if (masked.ok) return { ok: true, passphrase: masked.passphrase };
		if (masked.reason === "cancelled") return { ok: false, reason: "cancelled" };
		// `no-ui` / `unavailable` — fall through to the unmasked path.
	}

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
		return { ok: false, reason: "cancelled" };
	}
	if (value.length === 0) {
		return { ok: false, reason: "cancelled" };
	}

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

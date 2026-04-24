/**
 * Masked passphrase overlay.
 *
 * Renders a floating dialog via `ctx.ui.custom({ overlay: true })` with a
 * single-line input field that displays a `•` per entered code unit. The
 * real value never reaches the terminal: on render we emit only bullets,
 * and on submit we copy the string into a Buffer, overwrite the captured
 * string reference, and let the caller zero the Buffer when done.
 *
 * Falls back to the unmasked `ctx.ui.input()` dialog when `ctx.ui.custom`
 * isn't available — that path is exercised by RPC/print mode transports
 * and by unit tests that stub only the bare `input` surface.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type Component, CURSOR_MARKER, type Focusable, visibleWidth } from "@mariozechner/pi-tui";
import { EMPTY_MASKED_STATE, handleMaskedKey, type MaskedInputState, scrubString } from "./masked-input.js";

export interface MaskedPromptRequest {
	title: string;
	/** Optional secondary line (e.g. short key id). */
	keyid?: string;
	/** Hint shown at the bottom of the dialog. Default: "Enter to submit • Esc to cancel". */
	hint?: string;
	/** Aborts the prompt if signalled. */
	signal?: AbortSignal;
}

export type MaskedPromptResult =
	| { ok: true; passphrase: Buffer }
	| { ok: false; reason: "cancelled" | "no-ui" | "unavailable" };

/** Unicode bullet used in place of each captured code unit. */
const BULLET = "•";

/**
 * Show the masked overlay and resolve with a Buffer copy of the entered
 * passphrase. The Buffer is owned by the caller, who must zero it.
 */
export async function promptPassphraseMasked(
	ctx: ExtensionContext,
	req: MaskedPromptRequest,
): Promise<MaskedPromptResult> {
	if (!ctx.hasUI) return { ok: false, reason: "no-ui" };
	if (typeof ctx.ui.custom !== "function") return { ok: false, reason: "unavailable" };

	const hint = req.hint ?? "Enter to submit · Esc to cancel";

	try {
		const raw = await ctx.ui.custom<string | null>(
			(_tui, theme, _kb, done) => new MaskedPromptComponent(theme, { ...req, hint }, done),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "50%",
					minWidth: 40,
					maxHeight: "40%",
				},
			},
		);

		if (raw === null || raw === undefined) {
			return { ok: false, reason: "cancelled" };
		}
		if (raw.length === 0) {
			// Empty submit treated as cancel to avoid shipping empty passphrases
			// downstream — gpg would reject them but the UX is also confusing.
			return { ok: false, reason: "cancelled" };
		}

		const passphrase = Buffer.from(raw, "utf8");
		// Best-effort: drop the string reference so the only remaining copy is
		// the Buffer, which the caller can zero. (V8 may still retain interned
		// copies — see README threat model.)
		scrubString(raw);
		return { ok: true, passphrase };
	} catch (err) {
		if (req.signal?.aborted) return { ok: false, reason: "cancelled" };
		throw err;
	}
}

/**
 * Overlay component backing `promptPassphraseMasked`. Keeps the live
 * passphrase in a field that's overwritten when the dialog resolves; the
 * renderer only ever draws bullets.
 */
class MaskedPromptComponent implements Component, Focusable {
	focused = false;

	private state: MaskedInputState = EMPTY_MASKED_STATE;
	private resolved = false;
	private cachedLines: string[] | undefined;
	private readonly unsubscribeAbort: (() => void) | null;

	constructor(
		private readonly theme: Theme,
		private readonly req: Required<Pick<MaskedPromptRequest, "hint">> & MaskedPromptRequest,
		private readonly done: (result: string | null) => void,
	) {
		if (req.signal) {
			const onAbort = () => this.finish(null);
			req.signal.addEventListener("abort", onAbort, { once: true });
			this.unsubscribeAbort = () => req.signal?.removeEventListener("abort", onAbort);
			if (req.signal.aborted) queueMicrotask(onAbort);
		} else {
			this.unsubscribeAbort = null;
		}
	}

	handleInput(data: string): void {
		if (this.resolved) return;
		const action = handleMaskedKey(this.state, data);
		this.state = action.next;
		this.cachedLines = undefined;

		if (action.kind === "submit") {
			// Snapshot before we scrub the state — hand the string to `done`.
			const out = this.state.value;
			// Overwrite our own reference first so the only live copy is the
			// one we're handing to the caller.
			this.state = EMPTY_MASKED_STATE;
			this.finish(out);
			return;
		}
		if (action.kind === "cancel") {
			this.state = EMPTY_MASKED_STATE;
			this.finish(null);
			return;
		}
	}

	render(_width: number): string[] {
		if (this.cachedLines) return this.cachedLines;
		const th = this.theme;

		// Render with a fixed inner width driven by the overlay's configured
		// width; the TUI will still truncate if the terminal is narrower.
		// We render ~46 cols of content so the dialog stays compact.
		const innerW = 46;
		const pad = (s: string): string => {
			const vw = visibleWidth(s);
			return s + " ".repeat(Math.max(0, innerW - vw));
		};
		const row = (content: string) => th.fg("border", "│") + pad(content) + th.fg("border", "│");

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", this.req.title)}`));
		if (this.req.keyid) {
			lines.push(row(` ${th.fg("muted", `key ${this.req.keyid}`)}`));
		}
		lines.push(row(""));

		// Field row: label, then masked bullets, with a reverse-video cursor
		// and hardware cursor marker (for IME positioning) when focused.
		const label = ` ${th.fg("text", "passphrase:")} `;
		const available = innerW - visibleWidth(label) - 2;
		const bulletLine = this.renderField(available);
		lines.push(row(label + bulletLine));

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", this.req.hint)}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	dispose(): void {
		// Belt-and-suspenders: overwrite the captured state in case we were
		// torn down without going through submit/cancel (e.g. overlay hidden
		// from outside, session shutdown).
		this.state = EMPTY_MASKED_STATE;
		this.unsubscribeAbort?.();
	}

	private finish(result: string | null): void {
		if (this.resolved) return;
		this.resolved = true;
		this.unsubscribeAbort?.();
		this.done(result);
	}

	/**
	 * Render the masked field: `•` per code unit, with a reverse-video block
	 * at the cursor position. Emits `CURSOR_MARKER` when focused so IME
	 * composition anchors to the right cell.
	 */
	private renderField(width: number): string {
		const th = this.theme;
		const bullets = BULLET.repeat(this.state.value.length);
		const cursor = Math.max(0, Math.min(this.state.value.length, this.state.cursor));

		// Horizontal scroll: keep the cursor inside the visible window.
		const visibleCount = Math.max(1, width);
		let start = 0;
		if (cursor >= visibleCount) start = cursor - visibleCount + 1;
		const slice = bullets.slice(start, start + visibleCount);
		const relCursor = cursor - start;

		const before = slice.slice(0, relCursor);
		const at = slice[relCursor] ?? " ";
		const after = slice.slice(relCursor + 1);

		const marker = this.focused ? CURSOR_MARKER : "";
		const cursorGlyph = `\x1b[7m${at}\x1b[27m`; // reverse-video
		const text = th.fg("accent", before) + marker + cursorGlyph + th.fg("accent", after);

		const vw = visibleWidth(text);
		return text + " ".repeat(Math.max(0, width - vw));
	}
}

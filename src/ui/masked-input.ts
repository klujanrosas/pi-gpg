/**
 * Pure state machine for a single-line masked passphrase field.
 *
 * Split out from the renderer so we can test keyboard semantics directly —
 * the `ctx.ui.custom` overlay path requires a live TUI that's painful to
 * assemble under vitest.
 *
 * Deliberately minimal compared to `pi-tui`'s `Input`:
 *   - no kill ring (yank/yank-pop) — would pull passphrase bytes into a ring
 *     buffer that outlives the dialog
 *   - no undo stack — same reason
 *   - no bracketed-paste buffering — we accept paste events as a single
 *     replacement instead (see `applyPaste`) so nothing is retained
 *
 * Public API is all pure functions on the immutable `MaskedInputState` record.
 */

export interface MaskedInputState {
	/** Current buffered value. Callers must zero this when done. */
	readonly value: string;
	/** Insertion point (in code units, not graphemes — passphrases are ASCII 99% of the time). */
	readonly cursor: number;
}

export type MaskedAction =
	| { kind: "none"; next: MaskedInputState }
	| { kind: "submit"; next: MaskedInputState }
	| { kind: "cancel"; next: MaskedInputState };

export const EMPTY_MASKED_STATE: MaskedInputState = { value: "", cursor: 0 };

/**
 * Feed a single chunk of terminal input into the state and produce a new
 * state plus an optional action. The caller is responsible for zeroing the
 * returned `value` buffer when the dialog closes.
 *
 * Accepts printable characters (including Unicode) and a small keybinding
 * surface: Backspace, Delete, Home/End, Left/Right, Enter (submit), Esc
 * (cancel), Ctrl+U (clear). Intentionally ignores Ctrl+W / Ctrl+K-style kills
 * to avoid any kill-ring semantics.
 */
export function handleMaskedKey(state: MaskedInputState, data: string): MaskedAction {
	// Bracketed paste envelope — strip the markers and treat the body as one
	// insertion, so nothing lingers in an internal buffer.
	if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) {
		const body = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
		const clean = body.replace(/\r\n|\r|\n|\t/g, "");
		if (clean.length === 0) return { kind: "none", next: state };
		return { kind: "none", next: insert(state, clean) };
	}

	// Control keys — match the short literal sequences Pi's TUI delivers.
	switch (data) {
		case "\r":
		case "\n":
			return { kind: "submit", next: state };

		case "\x1b": // Esc
			return { kind: "cancel", next: EMPTY_MASKED_STATE };

		// Backspace variants (BS, DEL).
		case "\x7f":
		case "\b":
			return { kind: "none", next: backspace(state) };

		// Ctrl+U — clear line.
		case "\x15":
			return { kind: "none", next: EMPTY_MASKED_STATE };

		// Arrows — both legacy CSI and Kitty single-byte forms.
		case "\x1b[D": // Left
			return { kind: "none", next: moveCursor(state, -1) };
		case "\x1b[C": // Right
			return { kind: "none", next: moveCursor(state, +1) };
		case "\x1b[H": // Home
		case "\x01": // Ctrl+A
			return { kind: "none", next: { ...state, cursor: 0 } };
		case "\x1b[F": // End
		case "\x05": // Ctrl+E
			return { kind: "none", next: { ...state, cursor: state.value.length } };
		case "\x1b[3~": // Forward delete
			return { kind: "none", next: forwardDelete(state) };
	}

	// Any other control char (C0/C1/DEL) is silently dropped. Printable input
	// — including multibyte UTF-8 — gets inserted verbatim.
	if (hasControlChars(data)) return { kind: "none", next: state };
	return { kind: "none", next: insert(state, data) };
}

/** Insert `chunk` at the cursor. */
export function insert(state: MaskedInputState, chunk: string): MaskedInputState {
	if (chunk.length === 0) return state;
	const next = state.value.slice(0, state.cursor) + chunk + state.value.slice(state.cursor);
	return { value: next, cursor: state.cursor + chunk.length };
}

/** Delete one code unit before the cursor. */
export function backspace(state: MaskedInputState): MaskedInputState {
	if (state.cursor === 0) return state;
	const next = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
	return { value: next, cursor: state.cursor - 1 };
}

/** Delete one code unit at the cursor. */
export function forwardDelete(state: MaskedInputState): MaskedInputState {
	if (state.cursor >= state.value.length) return state;
	const next = state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1);
	return { value: next, cursor: state.cursor };
}

/** Move the cursor by `delta`, clamped to the value length. */
export function moveCursor(state: MaskedInputState, delta: number): MaskedInputState {
	const cursor = Math.max(0, Math.min(state.value.length, state.cursor + delta));
	return { ...state, cursor };
}

/** True if `data` contains any C0 / DEL / C1 control bytes. */
function hasControlChars(data: string): boolean {
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
	}
	return false;
}

/**
 * Best-effort overwrite of a captured passphrase string. JavaScript strings
 * are immutable so this cannot truly zero the underlying memory — the caller
 * must rely on `Buffer`-level zeroing once the string has been encoded.
 * Exposed here purely so the overlay can drop its reference to the raw
 * string and let GC scavenge it quickly.
 */
export function scrubString(value: string): string {
	return "\0".repeat(value.length);
}

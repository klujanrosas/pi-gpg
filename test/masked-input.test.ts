/**
 * Unit tests for the masked-input state machine. These cover the pure
 * keystroke → state transformation; the overlay renderer is tested
 * separately with a lighter integration-style test.
 */

import { describe, expect, it } from "vitest";
import {
	backspace,
	EMPTY_MASKED_STATE,
	forwardDelete,
	handleMaskedKey,
	insert,
	type MaskedInputState,
	moveCursor,
} from "../src/ui/masked-input.js";

const seed = (value: string, cursor?: number): MaskedInputState => ({ value, cursor: cursor ?? value.length });

describe("handleMaskedKey — text entry", () => {
	it("inserts a single character at the cursor", () => {
		const action = handleMaskedKey(EMPTY_MASKED_STATE, "a");
		expect(action.kind).toBe("none");
		expect(action.next).toEqual({ value: "a", cursor: 1 });
	});

	it("inserts unicode", () => {
		const action = handleMaskedKey(EMPTY_MASKED_STATE, "é");
		expect(action.next.value).toBe("é");
	});

	it("inserts multi-char payloads verbatim", () => {
		const action = handleMaskedKey(EMPTY_MASKED_STATE, "abc");
		expect(action.next).toEqual({ value: "abc", cursor: 3 });
	});

	it("ignores C0/C1/DEL control bytes that don't match a known binding", () => {
		// \x02 is Ctrl+B — unmapped, should be dropped silently.
		const action = handleMaskedKey(seed("x"), "\x02");
		expect(action.next).toEqual({ value: "x", cursor: 1 });
	});
});

describe("handleMaskedKey — editing", () => {
	it("backspaces", () => {
		const action = handleMaskedKey(seed("abc"), "\x7f");
		expect(action.next).toEqual({ value: "ab", cursor: 2 });
	});

	it("backspace at position 0 is a no-op", () => {
		const action = handleMaskedKey(seed("abc", 0), "\x7f");
		expect(action.next).toEqual({ value: "abc", cursor: 0 });
	});

	it("forward delete removes the char at the cursor", () => {
		const action = handleMaskedKey(seed("abc", 1), "\x1b[3~");
		expect(action.next).toEqual({ value: "ac", cursor: 1 });
	});

	it("Ctrl+U clears the line", () => {
		const action = handleMaskedKey(seed("hunter2"), "\x15");
		expect(action.next).toEqual(EMPTY_MASKED_STATE);
	});
});

describe("handleMaskedKey — navigation", () => {
	it("moves left/right", () => {
		expect(handleMaskedKey(seed("ab", 2), "\x1b[D").next.cursor).toBe(1);
		expect(handleMaskedKey(seed("ab", 0), "\x1b[C").next.cursor).toBe(1);
	});

	it("clamps arrow movement at boundaries", () => {
		expect(handleMaskedKey(seed("ab", 0), "\x1b[D").next.cursor).toBe(0);
		expect(handleMaskedKey(seed("ab", 2), "\x1b[C").next.cursor).toBe(2);
	});

	it("Home / Ctrl+A → 0; End / Ctrl+E → length", () => {
		expect(handleMaskedKey(seed("abc", 2), "\x01").next.cursor).toBe(0);
		expect(handleMaskedKey(seed("abc", 0), "\x05").next.cursor).toBe(3);
		expect(handleMaskedKey(seed("abc", 2), "\x1b[H").next.cursor).toBe(0);
		expect(handleMaskedKey(seed("abc", 0), "\x1b[F").next.cursor).toBe(3);
	});
});

describe("handleMaskedKey — terminal actions", () => {
	it("Enter submits with the current value", () => {
		const action = handleMaskedKey(seed("pw"), "\r");
		expect(action.kind).toBe("submit");
		expect(action.next).toEqual({ value: "pw", cursor: 2 });
	});

	it("Esc cancels and clears the state", () => {
		const action = handleMaskedKey(seed("pw"), "\x1b");
		expect(action.kind).toBe("cancel");
		expect(action.next).toEqual(EMPTY_MASKED_STATE);
	});
});

describe("handleMaskedKey — bracketed paste", () => {
	it("strips paste markers and treats the body as a single insert", () => {
		const action = handleMaskedKey(EMPTY_MASKED_STATE, "\x1b[200~hunter2\x1b[201~");
		expect(action.kind).toBe("none");
		expect(action.next).toEqual({ value: "hunter2", cursor: 7 });
	});

	it("drops CR/LF/tab from pasted bodies", () => {
		const action = handleMaskedKey(EMPTY_MASKED_STATE, "\x1b[200~a\nb\tc\x1b[201~");
		expect(action.next.value).toBe("abc");
	});
});

describe("helpers", () => {
	it("insert is a pure transform", () => {
		expect(insert(seed("ab", 1), "X")).toEqual({ value: "aXb", cursor: 2 });
	});

	it("backspace / forwardDelete clamp at bounds", () => {
		expect(backspace(seed("ab", 0))).toEqual(seed("ab", 0));
		expect(forwardDelete(seed("ab", 2))).toEqual(seed("ab", 2));
	});

	it("moveCursor clamps", () => {
		expect(moveCursor(seed("ab", 0), -10)).toEqual(seed("ab", 0));
		expect(moveCursor(seed("ab", 0), +10)).toEqual(seed("ab", 2));
	});
});

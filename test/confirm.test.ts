/**
 * Per-commit confirm policy: unit tests for the gate logic. ctx.ui.confirm
 * is mocked as a scripted sequence; we assert on dialog counts and the
 * "first-in-session" set behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ConfirmedKeySet, confirmCommit } from "../src/confirm.js";

interface MockCtx {
	hasUI: boolean;
	ui: { confirm: ReturnType<typeof vi.fn> };
}

function makeCtx(results: (boolean | undefined)[] = [], hasUI = true): MockCtx {
	const confirm = vi.fn();
	for (const r of results) confirm.mockResolvedValueOnce(r);
	return { hasUI, ui: { confirm } };
}

const BASE = {
	keyid: "ABCD1234",
	keyDisplay: "ABCD1234",
	operation: "git_commit",
	subject: "feat: hello",
} as const;

describe("confirmCommit — policy: never", () => {
	it("never prompts and always allows", async () => {
		const ctx = makeCtx();
		const session: ConfirmedKeySet = new Set();
		const result = await confirmCommit(ctx as never, { ...BASE, policy: "never", session });
		expect(result).toEqual({ ok: true, skipped: true });
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});
});

describe("confirmCommit — policy: always", () => {
	let session: ConfirmedKeySet;
	beforeEach(() => {
		session = new Set();
	});

	it("prompts every time", async () => {
		const ctx = makeCtx([true, true]);
		const first = await confirmCommit(ctx as never, { ...BASE, policy: "always", session });
		const second = await confirmCommit(ctx as never, { ...BASE, policy: "always", session });
		expect(first).toEqual({ ok: true, skipped: false });
		expect(second).toEqual({ ok: true, skipped: false });
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
		expect(session.size).toBe(0);
	});

	it("rejects on denial", async () => {
		const ctx = makeCtx([false]);
		const r = await confirmCommit(ctx as never, { ...BASE, policy: "always", session });
		expect(r).toEqual({ ok: false, reason: "denied" });
	});

	it("fails closed when there's no UI", async () => {
		const ctx = makeCtx([], false);
		const r = await confirmCommit(ctx as never, { ...BASE, policy: "always", session });
		expect(r).toEqual({ ok: false, reason: "no-ui" });
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});
});

describe("confirmCommit — policy: first-in-session", () => {
	let session: ConfirmedKeySet;
	beforeEach(() => {
		session = new Set();
	});

	it("prompts on first use and records the key", async () => {
		const ctx = makeCtx([true]);
		const r = await confirmCommit(ctx as never, { ...BASE, policy: "first-in-session", session });
		expect(r).toEqual({ ok: true, skipped: false });
		expect(session.has(BASE.keyid)).toBe(true);
	});

	it("skips subsequent prompts for the same key", async () => {
		session.add(BASE.keyid);
		const ctx = makeCtx();
		const r = await confirmCommit(ctx as never, { ...BASE, policy: "first-in-session", session });
		expect(r).toEqual({ ok: true, skipped: true });
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("does not record the key on denial", async () => {
		const ctx = makeCtx([false]);
		const r = await confirmCommit(ctx as never, { ...BASE, policy: "first-in-session", session });
		expect(r).toEqual({ ok: false, reason: "denied" });
		expect(session.has(BASE.keyid)).toBe(false);
	});

	it("treats different keyids independently", async () => {
		const ctx = makeCtx([true, true]);
		const a = await confirmCommit(ctx as never, { ...BASE, keyid: "AAA", policy: "first-in-session", session });
		const b = await confirmCommit(ctx as never, { ...BASE, keyid: "BBB", policy: "first-in-session", session });
		expect(a.ok && b.ok).toBe(true);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
		expect(session.has("AAA")).toBe(true);
		expect(session.has("BBB")).toBe(true);
	});
});

/**
 * Sign-gate: exercise the composition of Touch ID gating and confirm policy.
 *
 * We stub the Touch ID helper via module mock and drive `ctx.ui.confirm`
 * directly. No real LA, no real UI.
 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { formatGateReason, runSignGate, type SignGateRequest } from "../src/gate.js";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("../src/touchid.js", () => ({
	authenticateTouchId: authMock,
	isTouchIdSupportedPlatform: () => true,
}));

interface MockCtx {
	hasUI: boolean;
	ui: { confirm: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
}

function makeCtx(confirmResults: (boolean | undefined)[] = []): MockCtx {
	const confirm = vi.fn();
	for (const r of confirmResults) confirm.mockResolvedValueOnce(r);
	return {
		hasUI: true,
		ui: {
			confirm,
			notify: vi.fn(),
		},
	};
}

function baseReq(overrides: Partial<SignGateRequest> = {}): SignGateRequest {
	return {
		config: { ...DEFAULT_CONFIG, confirmPolicy: "never" },
		confirmedKeys: new Set<string>(),
		keyid: "ABCD1234",
		keyDisplay: "ABCD1234",
		operation: "git_commit",
		fromCache: false,
		...overrides,
	};
}

describe("runSignGate", () => {
	it("passes through with both policies disabled", async () => {
		authMock.mockReset();
		const ctx = makeCtx();
		const r = await runSignGate(ctx as never, baseReq());
		expect(r).toEqual({ ok: true });
		expect(authMock).not.toHaveBeenCalled();
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("runs the confirm dialog when policy = always", async () => {
		authMock.mockReset();
		const ctx = makeCtx([true]);
		const r = await runSignGate(ctx as never, baseReq({ config: { ...DEFAULT_CONFIG, confirmPolicy: "always" } }));
		expect(r.ok).toBe(true);
		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
	});

	it("skips Touch ID when fromCache=false (fresh prompt is presence)", async () => {
		authMock.mockReset();
		const ctx = makeCtx();
		const r = await runSignGate(
			ctx as never,
			baseReq({
				config: { ...DEFAULT_CONFIG, touchIdGating: true, confirmPolicy: "never" },
				fromCache: false,
			}),
		);
		expect(r.ok).toBe(true);
		expect(authMock).not.toHaveBeenCalled();
	});

	it("runs Touch ID on cache release when enabled", async () => {
		authMock.mockReset();
		authMock.mockResolvedValueOnce({ ok: true });
		const ctx = makeCtx();
		const r = await runSignGate(
			ctx as never,
			baseReq({
				config: { ...DEFAULT_CONFIG, touchIdGating: true, confirmPolicy: "never" },
				fromCache: true,
			}),
		);
		expect(r.ok).toBe(true);
		expect(authMock).toHaveBeenCalledTimes(1);
	});

	it("propagates a Touch ID denial", async () => {
		authMock.mockReset();
		authMock.mockResolvedValueOnce({ ok: false, reason: "cancelled", detail: "user cancelled" });
		const ctx = makeCtx();
		const r = await runSignGate(
			ctx as never,
			baseReq({
				config: { ...DEFAULT_CONFIG, touchIdGating: true, confirmPolicy: "never" },
				fromCache: true,
			}),
		);
		expect(r).toEqual({ ok: false, reason: "touchid-denied", detail: "user cancelled" });
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});

	it("propagates Touch ID unavailability with a notification", async () => {
		authMock.mockReset();
		authMock.mockResolvedValueOnce({ ok: false, reason: "unavailable", detail: "no swiftc" });
		const ctx = makeCtx();
		const r = await runSignGate(
			ctx as never,
			baseReq({
				config: { ...DEFAULT_CONFIG, touchIdGating: true, confirmPolicy: "never" },
				fromCache: true,
			}),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("touchid-unavailable");
		expect(ctx.ui.notify).toHaveBeenCalled();
	});

	it("formatGateReason produces a human-readable message for each reason", () => {
		expect(formatGateReason({ ok: false, reason: "touchid-denied" })).toMatch(/Touch ID/);
		expect(formatGateReason({ ok: false, reason: "touchid-unavailable" })).toMatch(/Touch ID/);
		expect(formatGateReason({ ok: false, reason: "confirm-denied" })).toMatch(/cancelled/i);
		expect(formatGateReason({ ok: false, reason: "confirm-no-ui" })).toMatch(/UI/);
	});
});

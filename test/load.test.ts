import { describe, expect, it, vi } from "vitest";

/**
 * Smoke test: the extension module must import and expose a default function
 * that accepts Pi's ExtensionAPI without throwing during registration.
 *
 * We feed a minimal mock Pi and verify that our handlers / commands are
 * registered with the expected names. This is the cheapest possible
 * signal that the extension can load inside Pi.
 */
describe("extension load", () => {
	it("default export registers session_start, session_shutdown, /gpg-doctor, /gpg-status", async () => {
		const mod = await import("../src/index.js");
		expect(typeof mod.default).toBe("function");

		const events: string[] = [];
		const commands: string[] = [];

		const pi = {
			on: vi.fn((event: string, _handler: unknown) => {
				events.push(event);
			}),
			registerCommand: vi.fn((name: string, _opts: unknown) => {
				commands.push(name);
			}),
			exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
		} as unknown as Parameters<typeof mod.default>[0];

		mod.default(pi);

		expect(events).toContain("session_start");
		expect(events).toContain("session_shutdown");
		expect(commands).toContain("gpg-doctor");
		expect(commands).toContain("gpg-status");
	});
});

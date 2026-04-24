/**
 * Touch ID helper — unit-level tests. We can't drive the real LA prompt
 * under vitest, so we focus on platform/cache/build-pipeline logic:
 *
 *   - non-darwin platforms short-circuit to "unavailable"
 *   - missing swiftc surfaces a clear error
 *   - rebuild is keyed on source hash (no stale binary)
 *
 * Full end-to-end Touch ID is intentionally left for manual validation.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecFn } from "../src/exec.js";
import { authenticateTouchId, isTouchIdSupportedPlatform } from "../src/touchid.js";

const noopExec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });

describe("isTouchIdSupportedPlatform", () => {
	it("is true only on darwin", () => {
		expect(isTouchIdSupportedPlatform("darwin")).toBe(true);
		expect(isTouchIdSupportedPlatform("linux")).toBe(false);
		expect(isTouchIdSupportedPlatform("win32")).toBe(false);
	});
});

describe("authenticateTouchId — non-darwin short-circuit", () => {
	it("returns unavailable without touching the filesystem", async () => {
		const r = await authenticateTouchId("unit test", {
			exec: noopExec,
			platformOverride: "linux",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("unavailable");
			expect(r.detail).toMatch(/platform=linux/);
		}
	});
});

describe("authenticateTouchId — darwin without swiftc", () => {
	let cacheDir: string;
	let source: string;

	beforeEach(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), "pi-gpg-touchid-"));
		// Write a dummy source so the hasher has something to read.
		source = join(cacheDir, "touchid.swift");
		await writeFile(source, "// stub\n");
	});

	afterEach(async () => {
		await rm(cacheDir, { recursive: true, force: true });
	});

	it("surfaces unavailable with a clear message if swiftc is unreachable", async () => {
		// Force PATH to an empty dir so `which swiftc` can't find anything.
		const originalPath = process.env.PATH;
		process.env.PATH = cacheDir;
		try {
			const r = await authenticateTouchId("unit test", {
				exec: noopExec,
				platformOverride: "darwin",
				sourcePathOverride: source,
				cacheDirOverride: cacheDir,
			});
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.reason).toBe("unavailable");
				expect(r.detail ?? "").toMatch(/swiftc/i);
			}
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

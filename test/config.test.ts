/**
 * Persistent config: round-trip, normalization, atomic writes, path resolution.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONFIG_SCHEMA_VERSION,
	createFileConfigStore,
	DEFAULT_CONFIG,
	normalizeConfig,
	resolveConfigPath,
} from "../src/config.js";

describe("resolveConfigPath", () => {
	it("prefers $XDG_CONFIG_HOME when set", () => {
		expect(resolveConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/pi-gpg/config.json");
	});

	it("falls back to ~/.config/pi-gpg/config.json", () => {
		expect(resolveConfigPath({}, "/home/u")).toBe("/home/u/.config/pi-gpg/config.json");
	});

	it("ignores an empty XDG value", () => {
		expect(resolveConfigPath({ XDG_CONFIG_HOME: "   " }, "/home/u")).toBe("/home/u/.config/pi-gpg/config.json");
	});
});

describe("normalizeConfig", () => {
	it("returns defaults for an empty object", () => {
		expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
	});

	it("drops unknown fields", () => {
		const out = normalizeConfig({ confirmPolicy: "always", bogus: 42 });
		expect(out).toEqual({ ...DEFAULT_CONFIG, confirmPolicy: "always" });
		expect("bogus" in out).toBe(false);
	});

	it("clamps invalid TTLs away (doesn't blow up)", () => {
		expect(normalizeConfig({ idleTtlSeconds: -1, maxTtlSeconds: "nope" }).idleTtlSeconds).toBeUndefined();
	});

	it("floors float TTLs", () => {
		expect(normalizeConfig({ idleTtlSeconds: 120.9 }).idleTtlSeconds).toBe(120);
	});

	it("rejects an unsupported schema version", () => {
		expect(() => normalizeConfig({ schema: 99 })).toThrow(/unsupported schema/);
	});

	it("rejects non-objects", () => {
		expect(() => normalizeConfig(null)).toThrow(/JSON object/);
		expect(() => normalizeConfig([])).toThrow(/JSON object/);
		expect(() => normalizeConfig("hi")).toThrow(/JSON object/);
	});

	it("accepts all three confirm policies", () => {
		for (const p of ["always", "never", "first-in-session"] as const) {
			expect(normalizeConfig({ confirmPolicy: p }).confirmPolicy).toBe(p);
		}
	});

	it("rejects garbage confirmPolicy by falling back to default", () => {
		expect(normalizeConfig({ confirmPolicy: "sometimes" }).confirmPolicy).toBe(DEFAULT_CONFIG.confirmPolicy);
	});
});

describe("FileConfigStore — round trip", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-gpg-cfg-"));
		path = join(dir, "config.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns defaults when the file is missing", async () => {
		const store = createFileConfigStore({ path });
		expect(await store.load()).toEqual(DEFAULT_CONFIG);
	});

	it("persists and reloads a config", async () => {
		const store = createFileConfigStore({ path });
		const custom = {
			...DEFAULT_CONFIG,
			confirmPolicy: "always" as const,
			touchIdGating: true,
			idleTtlSeconds: 60,
			maxTtlSeconds: 600,
		};
		await store.save(custom);
		expect(await store.load()).toEqual(custom);
	});

	it("writes atomically (no .tmp-* leftovers)", async () => {
		const store = createFileConfigStore({ path });
		await store.save({ ...DEFAULT_CONFIG, confirmPolicy: "never" });
		const fs = await import("node:fs/promises");
		const listed = await fs.readdir(dir);
		expect(listed).toEqual(["config.json"]);
	});

	it("throws on malformed JSON", async () => {
		await writeFile(path, "{nope", "utf8");
		const store = createFileConfigStore({ path });
		await expect(store.load()).rejects.toThrow(/not valid JSON/);
	});

	it("schema is stamped on save", async () => {
		const store = createFileConfigStore({ path });
		await store.save(DEFAULT_CONFIG);
		const raw = JSON.parse(await readFile(path, "utf8"));
		expect(raw.schema).toBe(CONFIG_SCHEMA_VERSION);
	});
});

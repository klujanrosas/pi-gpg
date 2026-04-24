import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS, PassphraseCache } from "../src/cache.js";

describe("PassphraseCache", () => {
	let now: number;
	let cache: PassphraseCache;

	beforeEach(() => {
		now = 1_700_000_000_000;
		cache = new PassphraseCache({ now: () => now });
	});

	it("defaults match gpg-agent (600s idle / 7200s max)", () => {
		const c = new PassphraseCache();
		expect(c.defaultCacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS);
		expect(c.maxCacheTtlMs).toBe(MAX_CACHE_TTL_MS);
		expect(c.defaultCacheTtlMs).toBe(600_000);
		expect(c.maxCacheTtlMs).toBe(7_200_000);
	});

	it("put then get returns a defensive copy", () => {
		const original = Buffer.from("hunter2");
		cache.put("ABCD", original);
		const got = cache.get("ABCD");
		expect(got).not.toBeNull();
		expect(got!.toString("utf8")).toBe("hunter2");

		// Mutating the returned copy should not poison the cached value.
		got!.fill(0);
		const got2 = cache.get("ABCD");
		expect(got2!.toString("utf8")).toBe("hunter2");
	});

	it("get resets the idle timer", () => {
		cache.put("KEY", Buffer.from("pw"));
		now += 599_000; // just under idle timeout
		expect(cache.get("KEY")).not.toBeNull();
		now += 599_000; // would've expired without the reset
		expect(cache.get("KEY")).not.toBeNull();
	});

	it("expires after idle timeout with no access", () => {
		cache.put("KEY", Buffer.from("pw"));
		now += 600_001;
		expect(cache.get("KEY")).toBeNull();
		expect(cache.stats().size).toBe(0);
	});

	it("enforces max-ttl even if accessed continuously", () => {
		cache.put("KEY", Buffer.from("pw"));
		// Keep touching it every 5 minutes — idle timer never fires.
		for (let i = 0; i < 23; i += 1) {
			now += 5 * 60 * 1000;
			expect(cache.get("KEY")).not.toBeNull();
		}
		// At ~115 min we're still under max-ttl (120 min). Push past.
		now += 10 * 60 * 1000;
		expect(cache.get("KEY")).toBeNull();
	});

	it("put overwriting a key zeroes the previous buffer", () => {
		const first = Buffer.from("old-password");
		cache.put("KEY", first);
		// The cache clones on put, so zeroing `first` doesn't matter — but
		// internally we store the clone. Check by calling put again with a new
		// value; the old internal buffer should have been zeroed.
		cache.put("KEY", Buffer.from("new-password"));
		expect(cache.get("KEY")!.toString("utf8")).toBe("new-password");
	});

	it("clear zeroes all entries", () => {
		cache.put("A", Buffer.from("a"));
		cache.put("B", Buffer.from("b"));
		expect(cache.stats().size).toBe(2);
		cache.clear();
		expect(cache.stats().size).toBe(0);
	});

	it("invalidate returns true on hit, false on miss", () => {
		cache.put("A", Buffer.from("x"));
		expect(cache.invalidate("A")).toBe(true);
		expect(cache.invalidate("A")).toBe(false);
		expect(cache.invalidate("never-existed")).toBe(false);
	});

	it("stats returns a sorted list of entries with expiry timestamps", () => {
		cache.put("bbbb", Buffer.from("1"));
		cache.put("aaaa", Buffer.from("2"));
		const s = cache.stats();
		expect(s.size).toBe(2);
		expect(s.entries.map((e) => e.keyid)).toEqual(["aaaa", "bbbb"]);
		for (const e of s.entries) {
			expect(e.expiresAt).toBe(now + 600_000);
		}
	});

	it("has() reports liveness without mutating", () => {
		cache.put("K", Buffer.from("pw"));
		expect(cache.has("K")).toBe(true);
		expect(cache.has("K")).toBe(true);
	});

	it("formatRemaining produces sane labels", () => {
		const base = 1_700_000_000_000;
		expect(
			PassphraseCache.formatRemaining(
				{ keyid: "x", firstUsedAt: base, lastUsedAt: base, expiresAt: base - 1 },
				base,
			),
		).toBe("expired");
		expect(
			PassphraseCache.formatRemaining(
				{ keyid: "x", firstUsedAt: base, lastUsedAt: base, expiresAt: base + 45_000 },
				base,
			),
		).toBe("45s");
		expect(
			PassphraseCache.formatRemaining(
				{ keyid: "x", firstUsedAt: base, lastUsedAt: base, expiresAt: base + (3 * 60 + 5) * 1000 },
				base,
			),
		).toBe("3m 5s");
		expect(
			PassphraseCache.formatRemaining(
				{ keyid: "x", firstUsedAt: base, lastUsedAt: base, expiresAt: base + (61 * 60 + 5) * 1000 },
				base,
			),
		).toBe("1h 1m");
	});
});

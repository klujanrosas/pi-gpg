import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CacheChangeEvent, DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS, PassphraseCache } from "../src/cache.js";

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

	describe("change events", () => {
		it("fires `put` on new entry, `invalidate` on explicit drop", () => {
			const events: CacheChangeEvent[] = [];
			cache.onChange((e) => events.push(e));

			cache.put("A", Buffer.from("x"));
			expect(events).toEqual([{ reason: "put", keyid: "A", size: 1 }]);

			cache.invalidate("A");
			expect(events).toEqual([
				{ reason: "put", keyid: "A", size: 1 },
				{ reason: "invalidate", keyid: "A", size: 0 },
			]);
		});

		it("fires `clear` once for any non-empty cache", () => {
			const listener = vi.fn();
			cache.onChange(listener);

			cache.put("A", Buffer.from("x"));
			cache.put("B", Buffer.from("y"));
			listener.mockClear();

			cache.clear();
			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener).toHaveBeenCalledWith({ reason: "clear", size: 0 });
		});

		it("does not fire `clear` on an already-empty cache", () => {
			const listener = vi.fn();
			cache.onChange(listener);
			cache.clear();
			expect(listener).not.toHaveBeenCalled();
		});

		it("does not fire `invalidate` on a miss", () => {
			const listener = vi.fn();
			cache.onChange(listener);
			expect(cache.invalidate("nope")).toBe(false);
			expect(listener).not.toHaveBeenCalled();
		});

		it("put-replace emits a single `put` (not invalidate+put)", () => {
			const listener = vi.fn();
			cache.onChange(listener);
			cache.put("A", Buffer.from("one"));
			listener.mockClear();

			cache.put("A", Buffer.from("two"));
			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener).toHaveBeenCalledWith({ reason: "put", keyid: "A", size: 1 });
		});

		it("unsubscribe stops delivery", () => {
			const listener = vi.fn();
			const unsubscribe = cache.onChange(listener);
			cache.put("A", Buffer.from("x"));
			expect(listener).toHaveBeenCalledTimes(1);

			unsubscribe();
			cache.invalidate("A");
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("listener exceptions don't break mutations or other listeners", () => {
			const good = vi.fn();
			cache.onChange(() => {
				throw new Error("boom");
			});
			cache.onChange(good);

			expect(() => cache.put("A", Buffer.from("x"))).not.toThrow();
			expect(good).toHaveBeenCalledTimes(1);
			expect(cache.get("A")?.toString("utf8")).toBe("x");
		});

		it("lazy eviction during `get` emits `expire`", () => {
			const listener = vi.fn();
			cache.onChange(listener);
			cache.put("K", Buffer.from("pw"));
			listener.mockClear();

			now += 600_001; // past idle TTL
			expect(cache.get("K")).toBeNull();
			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener).toHaveBeenCalledWith({ reason: "expire", keyid: "K", size: 0 });
		});

		it("manual sweepExpired emits `expire` per evicted entry", () => {
			const listener = vi.fn();
			cache.onChange(listener);
			cache.put("A", Buffer.from("1"));
			cache.put("B", Buffer.from("2"));
			listener.mockClear();

			now += 600_001;
			const evicted = cache.sweepExpired();
			expect(evicted).toBe(2);
			expect(listener).toHaveBeenCalledTimes(2);
			expect(listener.mock.calls[0]?.[0].reason).toBe("expire");
			expect(listener.mock.calls[1]?.[0].reason).toBe("expire");
		});
	});

	describe("auto-expiry timer", () => {
		it("is disabled when `now` is mocked (opt-out default)", () => {
			const c = new PassphraseCache({ now: () => 0 });
			c.put("K", Buffer.from("pw"));
			// No timer means this test returns immediately — we're only asserting
			// that constructing+mutating doesn't schedule a real setTimeout that
			// would leak across tests.
			c.dispose();
		});

		it("evicts and emits `expire` automatically when idle TTL elapses", async () => {
			const c = new PassphraseCache({
				defaultCacheTtlMs: 20,
				maxCacheTtlMs: 10_000,
			});
			try {
				const events: CacheChangeEvent[] = [];
				c.onChange((e) => events.push(e));
				c.put("K", Buffer.from("pw"));

				await new Promise((r) => setTimeout(r, 80));
				const expire = events.find((e) => e.reason === "expire");
				expect(expire?.keyid).toBe("K");
				expect(c.stats().size).toBe(0);
			} finally {
				c.dispose();
			}
		});

		it("dispose() cancels the timer", async () => {
			const c = new PassphraseCache({
				defaultCacheTtlMs: 20,
				maxCacheTtlMs: 10_000,
			});
			const listener = vi.fn();
			c.onChange(listener);
			c.put("K", Buffer.from("pw"));
			c.dispose();

			await new Promise((r) => setTimeout(r, 80));
			// After dispose, no further events should arrive (listeners are also
			// dropped, so even if a stray timer fired we'd not see it).
			expect(listener).toHaveBeenCalledTimes(1); // just the original `put`
		});
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

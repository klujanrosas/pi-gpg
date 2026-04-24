/**
 * Session-scoped passphrase cache.
 *
 * Mirrors gpg-agent's cache semantics:
 *   - `defaultCacheTtlMs` is an idle timeout. It resets on every successful use.
 *   - `maxCacheTtlMs` is a hard wall-clock cap from the first unlock.
 *
 * Values are stored as `Buffer` so we can best-effort zero them on eviction.
 * Node/V8 may still retain copies via GC moves; treat zeroization as hygiene,
 * not a guarantee.
 */

export const DEFAULT_CACHE_TTL_MS = 600_000; // 10 min — gpg-agent default
export const MAX_CACHE_TTL_MS = 7_200_000; // 2 hr  — gpg-agent default

export interface CacheOptions {
	/** Idle timeout. Extended on every `get` hit. Default: 600s. */
	defaultCacheTtlMs?: number;
	/** Hard cap from first unlock. Not extended. Default: 7200s. */
	maxCacheTtlMs?: number;
	/** Override `Date.now()` — for deterministic tests. */
	now?: () => number;
}

export interface CacheEntry {
	keyid: string;
	firstUsedAt: number;
	lastUsedAt: number;
	expiresAt: number; // min(firstUsedAt + maxTtl, lastUsedAt + defaultTtl)
}

export interface CacheStats {
	size: number;
	entries: CacheEntry[];
}

interface InternalEntry {
	value: Buffer;
	firstUsedAt: number;
	lastUsedAt: number;
}

export class PassphraseCache {
	readonly defaultCacheTtlMs: number;
	readonly maxCacheTtlMs: number;
	private readonly now: () => number;
	private readonly entries = new Map<string, InternalEntry>();

	constructor(opts: CacheOptions = {}) {
		this.defaultCacheTtlMs = opts.defaultCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.maxCacheTtlMs = opts.maxCacheTtlMs ?? MAX_CACHE_TTL_MS;
		this.now = opts.now ?? Date.now;
	}

	/**
	 * Returns the cached passphrase (as a defensive copy) or `null` if no live
	 * entry exists. On return, the entry's idle timer is reset. Expired entries
	 * are invalidated as a side effect.
	 */
	get(keyid: string): Buffer | null {
		const entry = this.entries.get(keyid);
		if (!entry) return null;
		const now = this.now();
		if (now - entry.firstUsedAt > this.maxCacheTtlMs) {
			this.invalidate(keyid);
			return null;
		}
		if (now - entry.lastUsedAt > this.defaultCacheTtlMs) {
			this.invalidate(keyid);
			return null;
		}
		entry.lastUsedAt = now;
		// Defensive copy so the caller cannot mutate our stored Buffer.
		return Buffer.from(entry.value);
	}

	/**
	 * Store a passphrase. A prior entry for the same keyid is zeroed first.
	 * The provided buffer's bytes are copied; callers may zero their own copy
	 * afterwards if they wish.
	 */
	put(keyid: string, passphrase: Buffer): void {
		this.invalidate(keyid);
		const value = Buffer.from(passphrase);
		const now = this.now();
		this.entries.set(keyid, { value, firstUsedAt: now, lastUsedAt: now });
	}

	/** Remove and zero a single entry. */
	invalidate(keyid: string): boolean {
		const entry = this.entries.get(keyid);
		if (!entry) return false;
		entry.value.fill(0);
		this.entries.delete(keyid);
		return true;
	}

	/** Remove and zero all entries. Call on session_shutdown. */
	clear(): void {
		for (const entry of this.entries.values()) entry.value.fill(0);
		this.entries.clear();
	}

	has(keyid: string): boolean {
		// Use get() so expired entries self-evict, then check existence again.
		const buf = this.get(keyid);
		if (buf) {
			buf.fill(0);
			return true;
		}
		return false;
	}

	stats(): CacheStats {
		const entries: CacheEntry[] = [];
		for (const [keyid, entry] of this.entries) {
			const idleExpires = entry.lastUsedAt + this.defaultCacheTtlMs;
			const hardExpires = entry.firstUsedAt + this.maxCacheTtlMs;
			entries.push({
				keyid,
				firstUsedAt: entry.firstUsedAt,
				lastUsedAt: entry.lastUsedAt,
				expiresAt: Math.min(idleExpires, hardExpires),
			});
		}
		return { size: entries.length, entries: entries.sort((a, b) => a.keyid.localeCompare(b.keyid)) };
	}

	/**
	 * Formats a `CacheStats` record as `"5m 32s"` / `"1h 3m"` for UI display.
	 */
	static formatRemaining(entry: CacheEntry, now = Date.now()): string {
		const msLeft = Math.max(0, entry.expiresAt - now);
		const totalSeconds = Math.floor(msLeft / 1000);
		if (totalSeconds <= 0) return "expired";
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		if (hours > 0) return `${hours}h ${minutes}m`;
		if (minutes > 0) return `${minutes}m ${seconds}s`;
		return `${seconds}s`;
	}
}

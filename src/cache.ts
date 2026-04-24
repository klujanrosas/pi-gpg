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
	/**
	 * Run a background timer that evicts expired entries the moment they become
	 * stale (instead of lazy eviction inside `get`). Needed so that subscribers
	 * to `onChange` observe TTL-based transitions in real time — e.g. the Pi
	 * toolbar flipping from 🔓 to 🔒 when the cache idles out while nothing is
	 * running.
	 *
	 * Defaults to `true` when using real time, `false` when `now` is mocked
	 * (real timers + mocked time would drift apart).
	 */
	autoExpiry?: boolean;
}

/** Reasons a change event was emitted. Mostly informational — subscribers
 * that only re-render a status label can ignore the payload. */
export type CacheChangeReason = "put" | "invalidate" | "clear" | "expire";

export interface CacheChangeEvent {
	reason: CacheChangeReason;
	keyid?: string;
	/** Cache size *after* the change. */
	size: number;
}

export type CacheChangeListener = (event: CacheChangeEvent) => void;

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
	private readonly listeners = new Set<CacheChangeListener>();
	private readonly autoExpiry: boolean;
	private expiryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(opts: CacheOptions = {}) {
		this.defaultCacheTtlMs = opts.defaultCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
		this.maxCacheTtlMs = opts.maxCacheTtlMs ?? MAX_CACHE_TTL_MS;
		this.now = opts.now ?? Date.now;
		this.autoExpiry = opts.autoExpiry ?? opts.now === undefined;
	}

	/**
	 * Subscribe to change events (`put` / `invalidate` / `clear` / `expire`).
	 * Returns an unsubscribe function. Listener exceptions are swallowed so one
	 * buggy subscriber can't take down the cache.
	 */
	onChange(listener: CacheChangeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(reason: CacheChangeReason, keyid?: string): void {
		if (this.listeners.size === 0) return;
		const event: CacheChangeEvent = { reason, size: this.entries.size };
		if (keyid !== undefined) event.keyid = keyid;
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// swallow — subscribers must not break cache mutations
			}
		}
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
			this.expireOne(keyid);
			return null;
		}
		if (now - entry.lastUsedAt > this.defaultCacheTtlMs) {
			this.expireOne(keyid);
			return null;
		}
		entry.lastUsedAt = now;
		// `get` extends the idle timer; the previously-scheduled sweep for this
		// entry is now too early. Reschedule to the new earliest expiry.
		this.rescheduleExpiry();
		// Defensive copy so the caller cannot mutate our stored Buffer.
		return Buffer.from(entry.value);
	}

	/**
	 * Store a passphrase. A prior entry for the same keyid is zeroed first.
	 * The provided buffer's bytes are copied; callers may zero their own copy
	 * afterwards if they wish.
	 */
	put(keyid: string, passphrase: Buffer): void {
		// Don't emit an intermediate "invalidate" from the internal replace.
		const prior = this.entries.get(keyid);
		if (prior) {
			prior.value.fill(0);
			this.entries.delete(keyid);
		}
		const value = Buffer.from(passphrase);
		const now = this.now();
		this.entries.set(keyid, { value, firstUsedAt: now, lastUsedAt: now });
		this.rescheduleExpiry();
		this.emit("put", keyid);
	}

	/** Remove and zero a single entry. */
	invalidate(keyid: string): boolean {
		const entry = this.entries.get(keyid);
		if (!entry) return false;
		entry.value.fill(0);
		this.entries.delete(keyid);
		this.rescheduleExpiry();
		this.emit("invalidate", keyid);
		return true;
	}

	/** Remove and zero all entries. Call on session_shutdown. */
	clear(): void {
		const hadEntries = this.entries.size > 0;
		for (const entry of this.entries.values()) entry.value.fill(0);
		this.entries.clear();
		this.cancelExpiryTimer();
		if (hadEntries) this.emit("clear");
	}

	/**
	 * Release timers and drop subscribers. Call on `session_shutdown` after
	 * `clear()` if you want the cache to be fully inert (e.g. no pending
	 * `setTimeout` keeping Node alive in edge cases).
	 */
	dispose(): void {
		this.cancelExpiryTimer();
		this.listeners.clear();
	}

	/**
	 * Evict every entry whose idle or max TTL has elapsed, emitting an `expire`
	 * event per removal. Safe to call manually; normally invoked by the auto-
	 * expiry timer. Returns the number of entries evicted.
	 */
	sweepExpired(): number {
		const now = this.now();
		let evicted = 0;
		for (const [keyid, entry] of Array.from(this.entries)) {
			const idleExceeded = now - entry.lastUsedAt > this.defaultCacheTtlMs;
			const maxExceeded = now - entry.firstUsedAt > this.maxCacheTtlMs;
			if (idleExceeded || maxExceeded) {
				this.expireOne(keyid);
				evicted++;
			}
		}
		return evicted;
	}

	/** Internal eviction helper that emits `expire` rather than `invalidate`. */
	private expireOne(keyid: string): void {
		const entry = this.entries.get(keyid);
		if (!entry) return;
		entry.value.fill(0);
		this.entries.delete(keyid);
		this.rescheduleExpiry();
		this.emit("expire", keyid);
	}

	private cancelExpiryTimer(): void {
		if (this.expiryTimer) {
			clearTimeout(this.expiryTimer);
			this.expiryTimer = null;
		}
	}

	private rescheduleExpiry(): void {
		if (!this.autoExpiry) return;
		this.cancelExpiryTimer();
		if (this.entries.size === 0) return;

		let soonest = Number.POSITIVE_INFINITY;
		for (const entry of this.entries.values()) {
			const idle = entry.lastUsedAt + this.defaultCacheTtlMs;
			const hard = entry.firstUsedAt + this.maxCacheTtlMs;
			soonest = Math.min(soonest, idle, hard);
		}
		// +1ms slack so we fire *past* the TTL boundary — eviction uses strict
		// `>` comparison, so waking up at exactly `lastUsedAt + ttl` would find
		// the entry technically still alive and do nothing.
		const delay = Math.max(1, soonest - this.now() + 1);
		const timer = setTimeout(() => {
			this.expiryTimer = null;
			this.sweepExpired();
		}, delay);
		// Don't keep the event loop alive solely for this sweep — if nothing else
		// is pending, Pi's process should be free to exit.
		timer.unref?.();
		this.expiryTimer = timer;
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

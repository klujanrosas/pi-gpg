/**
 * Persistent pi-gpg configuration.
 *
 * Small, atomic, file-backed. Stored at
 *   $XDG_CONFIG_HOME/pi-gpg/config.json  (if XDG is set)
 *   $HOME/.config/pi-gpg/config.json     (default on Linux/macOS)
 *
 * Writes go through a tempfile + rename so a crashed write can't leave a
 * half-written JSON blob behind.
 *
 * Schema is versioned with `schema: 1`. Forward-compat strategy for readers:
 * unknown top-level keys are preserved on write; unknown schema versions are
 * rejected (we refuse to overwrite config we can't understand).
 *
 * Only pi-gpg runtime knobs live here. GPG itself is configured through
 * `~/.gnupg/gpg-agent.conf` / git-config as usual — those remain the source
 * of truth for the environment. This file layers policy choices pi-gpg
 * applies *on top* of that (confirm policy, Touch ID gating, cache overrides).
 */

import { constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_SCHEMA_VERSION = 1 as const;

export type ConfirmPolicy = "always" | "never" | "first-in-session";

export interface PiGpgConfig {
	/** Always `1` for this module's shape. */
	schema: typeof CONFIG_SCHEMA_VERSION;
	/**
	 * Override the idle TTL (seconds). When unset, pi-gpg reads
	 * `default-cache-ttl` from `gpg-agent.conf` or falls back to 600s.
	 */
	idleTtlSeconds?: number;
	/**
	 * Override the hard cap TTL (seconds). When unset, pi-gpg reads
	 * `max-cache-ttl` from `gpg-agent.conf` or falls back to 7200s.
	 */
	maxTtlSeconds?: number;
	/**
	 * Policy for per-commit confirmation dialogs:
	 *   "always"           — prompt every signed commit
	 *   "never"            — no confirm (just passphrase cache handling)
	 *   "first-in-session" — prompt once per session, per keyid (default)
	 */
	confirmPolicy: ConfirmPolicy;
	/**
	 * Require a Touch ID presence check before releasing any cached passphrase
	 * (macOS only). Ignored on other platforms.
	 */
	touchIdGating: boolean;
}

export const DEFAULT_CONFIG: PiGpgConfig = {
	schema: CONFIG_SCHEMA_VERSION,
	confirmPolicy: "first-in-session",
	touchIdGating: false,
};

/** Filesystem fetch/store implementation; factored out for tests. */
export interface ConfigStore {
	load(): Promise<PiGpgConfig>;
	save(config: PiGpgConfig): Promise<void>;
	/** Absolute path we would read/write. */
	readonly path: string;
}

export interface FileConfigStoreOptions {
	/** Override the resolved path. Used by tests. */
	path?: string;
	/** Override HOME resolution. Used by tests. */
	home?: string;
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	if (xdg) return join(xdg, "pi-gpg", "config.json");
	return join(home, ".config", "pi-gpg", "config.json");
}

/**
 * File-backed config store. Missing file → default config (not an error).
 * Malformed JSON → reject with a clear error so we don't silently lose
 * policy the user configured.
 */
export function createFileConfigStore(opts: FileConfigStoreOptions = {}): ConfigStore {
	const path = opts.path ?? resolveConfigPath(process.env, opts.home ?? homedir());

	return {
		path,
		async load() {
			let raw: string;
			try {
				raw = await readFile(path, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
				throw err;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (err) {
				throw new Error(`pi-gpg: config at ${path} is not valid JSON — ${(err as Error).message}`);
			}

			return normalizeConfig(parsed, path);
		},

		async save(config) {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const body = `${JSON.stringify(config, null, 2)}\n`;
			const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
			// Write with 0600 — this only holds policy, not secrets, but the
			// directory gets 0700 anyway; match.
			await writeFile(tmp, body, { encoding: "utf8", mode: 0o600, flag: "w" });
			try {
				await rename(tmp, path);
			} catch (err) {
				// Clean up the tmp file if rename failed.
				try {
					await import("node:fs/promises").then((fs) => fs.unlink(tmp));
				} catch {
					/* ignore */
				}
				throw err;
			}
			// Also narrow the final file to 0600 in case umask widened it.
			try {
				await (await import("node:fs/promises")).chmod(path, constants.S_IRUSR | constants.S_IWUSR);
			} catch {
				/* best-effort */
			}
		},
	};
}

/**
 * Coerce an arbitrary parsed JSON value into a valid `PiGpgConfig`. Unknown
 * fields are dropped; known fields are type-checked and clamped. Raising an
 * error here is reserved for schema mismatches we can't safely reconcile.
 */
export function normalizeConfig(input: unknown, sourcePath = "<config>"): PiGpgConfig {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error(`pi-gpg: config at ${sourcePath} must be a JSON object.`);
	}
	const obj = input as Record<string, unknown>;

	const schema = obj.schema;
	if (schema !== undefined && schema !== CONFIG_SCHEMA_VERSION) {
		throw new Error(
			`pi-gpg: config at ${sourcePath} has unsupported schema ${String(schema)}; expected ${CONFIG_SCHEMA_VERSION}.`,
		);
	}

	const out: PiGpgConfig = { ...DEFAULT_CONFIG };

	if (typeof obj.idleTtlSeconds === "number" && Number.isFinite(obj.idleTtlSeconds) && obj.idleTtlSeconds > 0) {
		out.idleTtlSeconds = Math.floor(obj.idleTtlSeconds);
	}
	if (typeof obj.maxTtlSeconds === "number" && Number.isFinite(obj.maxTtlSeconds) && obj.maxTtlSeconds > 0) {
		out.maxTtlSeconds = Math.floor(obj.maxTtlSeconds);
	}
	if (obj.confirmPolicy === "always" || obj.confirmPolicy === "never" || obj.confirmPolicy === "first-in-session") {
		out.confirmPolicy = obj.confirmPolicy;
	}
	if (typeof obj.touchIdGating === "boolean") {
		out.touchIdGating = obj.touchIdGating;
	}

	return out;
}

/** Describe the effective config for human display (used by /gpg-status and /gpg-config). */
export function describeConfig(cfg: PiGpgConfig): string[] {
	return [
		`confirm policy: ${cfg.confirmPolicy}`,
		`touch id gating: ${cfg.touchIdGating ? "on" : "off"}`,
		`idle ttl override: ${cfg.idleTtlSeconds != null ? `${cfg.idleTtlSeconds}s` : "(inherit)"}`,
		`max ttl override: ${cfg.maxTtlSeconds != null ? `${cfg.maxTtlSeconds}s` : "(inherit)"}`,
	];
}

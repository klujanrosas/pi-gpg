/**
 * Touch ID gating helper (macOS only).
 *
 * Wraps a tiny Swift helper (`shim/touchid.swift`) that calls
 * `LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, …)`
 * and exits 0 on success / 1 on denial / 2 on unavailable. We compile it
 * on first use with `swiftc` into a per-user cache directory (0700), then
 * invoke it synchronously when the user has enabled gating in `/gpg-config`.
 *
 * Policy:
 *   - Off on non-darwin platforms (short-circuit to `unavailable`).
 *   - Off when `swiftc` isn't on PATH (short-circuit with a clear diagnostic).
 *   - Binary is recompiled whenever the source hash changes, so package
 *     upgrades refresh it automatically.
 *   - The binary output lives in the pi-gpg cache dir alongside the source
 *     hash; no secrets pass through here at any point.
 *
 * None of this code touches the passphrase. It gates *release* of a cached
 * passphrase — the Buffer itself never crosses the helper process boundary.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecFn } from "./exec.js";

export type TouchIdOutcome = { ok: true } | { ok: false; reason: "cancelled" | "unavailable"; detail?: string };

export interface TouchIdDeps {
	/** Kept as a dependency for symmetry with the rest of the codebase. */
	exec: ExecFn;
	/** Override platform detection. Tests only. */
	platformOverride?: NodeJS.Platform;
	/** Override cache directory. Tests only. */
	cacheDirOverride?: string;
	/** Override Swift source path. Tests only. */
	sourcePathOverride?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_PATH = resolve(HERE, "..", "shim", "touchid.swift");

/** Short-circuit check callable from doctor / status without invoking Touch ID. */
export function isTouchIdSupportedPlatform(p: NodeJS.Platform = platform()): boolean {
	return p === "darwin";
}

/**
 * Prompt for biometric presence. On success, `{ ok: true }`. On any failure
 * we distinguish `cancelled` (user dismissed / biometric denied) from
 * `unavailable` (no LA policy, no Swift, non-darwin).
 *
 * Callers should treat `unavailable` as "fall through to passphrase entry"
 * if they still want to allow the operation — pi-gpg does *not* auto-allow
 * on unavailable, because Touch ID gating was explicitly opted into.
 */
export async function authenticateTouchId(
	reason: string,
	deps: TouchIdDeps = { exec: defaultExec },
): Promise<TouchIdOutcome> {
	const plat = deps.platformOverride ?? platform();
	if (!isTouchIdSupportedPlatform(plat)) {
		return { ok: false, reason: "unavailable", detail: `platform=${plat}` };
	}

	const sourcePath = deps.sourcePathOverride ?? DEFAULT_SOURCE_PATH;

	let binPath: string;
	try {
		binPath = await ensureHelperBuilt({ sourcePath, cacheDirOverride: deps.cacheDirOverride });
	} catch (err) {
		return { ok: false, reason: "unavailable", detail: (err as Error).message };
	}

	return new Promise<TouchIdOutcome>((resolvePromise) => {
		const child = spawn(binPath, [reason], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			resolvePromise({ ok: false, reason: "unavailable", detail: err.message });
		});
		child.on("exit", (code) => {
			if (code === 0) {
				resolvePromise({ ok: true });
				return;
			}
			if (code === 2 || code === 3) {
				resolvePromise({ ok: false, reason: "unavailable", detail: stderr.trim() || `exit=${code}` });
				return;
			}
			// 1 or null (killed) — treat as user-cancelled.
			resolvePromise({ ok: false, reason: "cancelled", detail: stderr.trim() || `exit=${code ?? "?"}` });
		});
	});
}

interface BuildOptions {
	sourcePath: string;
	cacheDirOverride?: string;
}

interface CacheLayout {
	dir: string;
	bin: string;
	hashFile: string;
}

/**
 * Compile `shim/touchid.swift` into a cached binary, reusing prior builds
 * when the source hash hasn't changed. Returns the absolute path to the
 * binary. Throws with a human-readable message when swiftc is unavailable
 * or compilation fails.
 */
export async function ensureHelperBuilt(opts: BuildOptions): Promise<string> {
	const source = await readFile(opts.sourcePath, "utf8");
	const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
	const layout = resolveCache(opts.cacheDirOverride);

	await mkdir(layout.dir, { recursive: true, mode: 0o700 });

	const existingHash = await readIfExists(layout.hashFile);
	const binOk = await pathExists(layout.bin);
	if (binOk && existingHash === hash) return layout.bin;

	// Need to (re)build.
	const swiftc = await which("swiftc");
	if (!swiftc) {
		throw new Error(
			"pi-gpg: swiftc not found on PATH. Install Xcode Command Line Tools (xcode-select --install) to enable Touch ID gating.",
		);
	}

	// Copy source into the cache dir so the compiler's tempfiles don't splash
	// on the repo (and so we compile a stable filename regardless of package
	// install path).
	const stagedSource = join(layout.dir, `touchid-${hash}.swift`);
	await copyFile(opts.sourcePath, stagedSource);

	const outputTmp = `${layout.bin}.tmp-${process.pid}`;
	await runSwiftc(swiftc, stagedSource, outputTmp);
	await chmod(outputTmp, 0o700);
	await safeRename(outputTmp, layout.bin);

	await writeFile(layout.hashFile, hash, { mode: 0o600 });

	// Tidy: leave only the current staged source so repeated rebuilds don't
	// accumulate.
	try {
		const fs = await import("node:fs/promises");
		const entries = await fs.readdir(layout.dir);
		for (const e of entries) {
			if (e.startsWith("touchid-") && e.endsWith(".swift") && e !== `touchid-${hash}.swift`) {
				await unlink(join(layout.dir, e)).catch(() => {});
			}
		}
	} catch {
		/* best-effort cleanup */
	}

	return layout.bin;
}

function resolveCache(override?: string): CacheLayout {
	const dir = override ?? join(homedir(), ".cache", "pi-gpg", "touchid");
	return {
		dir,
		bin: join(dir, "pi-gpg-touchid"),
		hashFile: join(dir, "source.hash"),
	};
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

async function readIfExists(p: string): Promise<string | null> {
	try {
		return await readFile(p, "utf8");
	} catch {
		return null;
	}
}

async function safeRename(from: string, to: string): Promise<void> {
	const fs = await import("node:fs/promises");
	try {
		await fs.rename(from, to);
	} catch (err) {
		// On some filesystems rename fails across devices — copy+unlink fallback.
		if ((err as NodeJS.ErrnoException).code === "EXDEV") {
			await copyFile(from, to);
			await unlink(from).catch(() => {});
			return;
		}
		throw err;
	}
}

function runSwiftc(swiftc: string, source: string, output: string): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(swiftc, ["-O", "-o", output, source], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (d) => {
			stderr += d.toString("utf8");
		});
		child.on("error", (err) => rejectPromise(err));
		child.on("exit", (code) => {
			if (code === 0) return resolvePromise();
			return rejectPromise(
				new Error(
					`pi-gpg: swiftc failed to build Touch ID helper (exit=${code})${stderr ? `\n${stderr.trim()}` : ""}`,
				),
			);
		});
	});
}

async function which(bin: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		const child = spawn("which", [bin], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout?.on("data", (d) => {
			out += d.toString("utf8");
		});
		child.on("exit", (code) => {
			if (code === 0) {
				const p = out.trim();
				resolvePromise(p || null);
			} else {
				resolvePromise(null);
			}
		});
		child.on("error", () => resolvePromise(null));
	});
}

const defaultExec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });

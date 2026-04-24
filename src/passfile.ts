/**
 * Temporary passphrase-file manager for the bash-interception path.
 *
 * When we cannot control the child process's fd table (bash tool runs the
 * user command in its own stdio), we fall back to writing the passphrase to
 * a mode-0600 file in the OS temp dir and pointing the shim at it via
 * `PI_GPG_PASSFILE`.
 *
 * Threat profile:
 *   - File mode is 0600 (owner read/write only).
 *   - Placed in OS temp dir; on macOS and modern Linux this is per-user.
 *   - Lifetime is at most the duration of a single bash tool call.
 *   - We track every live file in an in-process registry so session_shutdown
 *     can sweep anything that leaked.
 *
 * Not safe against: a hostile process running as the same user that races us.
 * That attacker would already have access to the signing key anyway (local
 * user == GPG key owner by default).
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PassfileHandle {
	path: string;
	cleanup(): Promise<void>;
}

/**
 * Registry of live passphrase files. Call `sweep()` on session_shutdown.
 *
 * We keep the *directory* in the registry rather than individual files so
 * that a single `rm -rf` is enough to clean up multiple concurrent routes.
 * Each file lives in its own directory, created with 0700.
 */
export class PassfileRegistry {
	private readonly dirs = new Set<string>();

	async allocate(passphrase: Buffer): Promise<PassfileHandle> {
		const dir = await mkdtemp(join(tmpdir(), "pi-gpg-"));
		await chmod(dir, 0o700);
		this.dirs.add(dir);
		const path = join(dir, "pass");
		await writeFile(path, Buffer.concat([passphrase, Buffer.from("\n")]), { mode: 0o600 });
		await chmod(path, 0o600);

		const cleanup = async () => {
			this.dirs.delete(dir);
			await rm(dir, { recursive: true, force: true });
		};
		return { path, cleanup };
	}

	async sweep(): Promise<void> {
		const dirs = Array.from(this.dirs);
		this.dirs.clear();
		await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true })));
	}

	get liveCount(): number {
		return this.dirs.size;
	}
}

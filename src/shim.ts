/**
 * Resolve and prepare the gpg-loopback shim.
 *
 * The shim ships as `shim/gpg-loopback.sh` in the package. We resolve it
 * relative to this module's URL so it works in all install shapes:
 *
 *   - local path install:   `<repo>/shim/gpg-loopback.sh`
 *   - npm install:          `<node_modules>/pi-gpg/shim/gpg-loopback.sh`
 *   - git install:          same as npm
 *   - `pi -e src/index.ts`: `<repo>/shim/gpg-loopback.sh`
 *
 * npm tarballs preserve file mode, but we still chmod +x on resolve to be
 * defensive against hostile extraction environments.
 */

import { constants as fsConstants } from "node:fs";
import { access, chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedShim {
	path: string;
	/** Resolved through realpath / existence check. */
	exists: boolean;
}

/**
 * Absolute path to the shim as shipped with this package. Throws if the
 * shim can't be located under the expected relative path.
 */
export async function resolveShim(moduleUrl: string = import.meta.url): Promise<ResolvedShim> {
	const here = fileURLToPath(moduleUrl);
	// From `src/shim.ts` → `../shim/gpg-loopback.sh`
	const path = resolve(dirname(here), "..", "shim", "gpg-loopback.sh");
	try {
		await access(path, fsConstants.F_OK);
	} catch {
		return { path, exists: false };
	}
	return { path, exists: true };
}

/** Ensure the shim is executable by the current user. */
export async function ensureExecutable(path: string): Promise<void> {
	try {
		const s = await stat(path);
		// Best effort: set user-execute bit without changing group/world.
		const want = s.mode | 0o100;
		if (want !== s.mode) await chmod(path, want);
	} catch {
		// If chmod fails (read-only FS, etc.), let the first invocation fail
		// with a useful error rather than hiding a permissions problem here.
	}
}

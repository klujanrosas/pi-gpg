/**
 * Spawn `git` with the gpg-loopback shim wired in.
 *
 * Two flavors:
 *
 *   - `runGitWithFd3Passphrase`: creates an anonymous pipe as fd 3, writes the
 *     passphrase, closes the write end. The shim execs gpg with
 *     `--passphrase-fd 3`. Passphrase never touches disk, argv, or env.
 *     Used by the `git_commit` tool (path A).
 *
 *   - `runGitWithPassfile`: used by the bash-interception path (path B); it
 *     does NOT spawn git itself — instead it prepares a PassfileHandle and
 *     the caller mutates `event.input.command` to pick it up through the
 *     shell via `PI_GPG_PASSFILE`.
 */

import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

export interface RunGitOptions {
	args: readonly string[];
	shimPath: string;
	cwd: string;
	env?: Record<string, string | undefined>;
	passphrase: Buffer;
	signal?: AbortSignal;
	realGpgPath?: string;
	/** Streaming callbacks, mainly for tool `onUpdate`. */
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	/** Override git binary. Defaults to "git". */
	gitPath?: string;
}

export interface RunGitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function runGitWithFd3Passphrase(opts: RunGitOptions): Promise<RunGitResult> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...opts.env,
		// Inject gpg.program via GIT_CONFIG_* — git propagates these to every
		// child git process (merge/rebase spawn `git commit` internally).
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "gpg.program",
		GIT_CONFIG_VALUE_0: opts.shimPath,
		PI_GPG_USE_FD3: "1",
	};
	if (opts.realGpgPath) env.PI_GPG_REAL_GPG = opts.realGpgPath;

	return new Promise((resolve, reject) => {
		const child = spawn(opts.gitPath ?? "git", [...opts.args], {
			cwd: opts.cwd,
			env,
			// stdio[3] = "pipe" creates an extra inheritable pipe visible to the
			// child (and to any process it execs) as file descriptor 3.
			stdio: ["ignore", "pipe", "pipe", "pipe"],
			...(opts.signal ? { signal: opts.signal } : {}),
		});

		// Write the passphrase (with trailing newline — gpg expects it) and
		// close the write end immediately. gpg will read it via --passphrase-fd 3.
		const passFd = child.stdio[3] as Writable;
		if (!passFd) {
			reject(new Error("pi-gpg: failed to open passphrase pipe (fd 3)"));
			return;
		}
		passFd.write(opts.passphrase);
		passFd.write("\n");
		passFd.end();

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (buf: Buffer) => {
			const s = buf.toString("utf8");
			stdout += s;
			opts.onStdout?.(s);
		});
		child.stderr?.on("data", (buf: Buffer) => {
			const s = buf.toString("utf8");
			stderr += s;
			opts.onStderr?.(s);
		});

		child.on("error", (err) => reject(err));
		child.on("close", (code) => {
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

/**
 * Wipe a passphrase buffer. Call this as soon as you've handed it off (spawn
 * wrote it to the pipe) so long-lived references drop.
 */
export function zeroize(buf: Buffer): void {
	buf.fill(0);
}

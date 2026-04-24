/**
 * Minimal exec abstraction.
 *
 * We don't import `pi.exec` directly in the pure modules so tests can inject
 * a mock without pulling in the whole Pi runtime. The extension entry point
 * adapts `pi.exec` to this shape.
 */

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type ExecFn = (command: string, args: readonly string[]) => Promise<ExecResult>;

/**
 * Wraps an ExecFn so it never throws on non-zero exit.
 * Returns `{ stdout: "", stderr: String(err), code: -1 }` if the underlying
 * process cannot be spawned (e.g. binary not found).
 */
export function safeExec(exec: ExecFn): ExecFn {
	return async (command, args) => {
		try {
			return await exec(command, args);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { stdout: "", stderr: message, code: -1 };
		}
	};
}

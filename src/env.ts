/**
 * Helpers for building env-var prefixes and shell-quoting values safely.
 *
 * We inject configuration into intercepted bash commands by prepending
 * `KEY='safe value' KEY2='…' <original>`. Values MUST be single-quote-wrapped
 * with internal single-quotes escaped — no exceptions. Paths with spaces or
 * exotic characters break naive `KEY=$VAL` prefixes.
 */

export interface BashEnvInjection {
	/**
	 * Absolute path to the gpg-loopback shim. Used as `gpg.program`.
	 */
	shimPath: string;
	/**
	 * Absolute path to a mode-0600 file containing the passphrase (+ trailing newline).
	 * Invoked by the shim via `--passphrase-file`.
	 */
	passfilePath: string;
	/**
	 * Optional override of the real gpg binary. Defaults to whatever `gpg`
	 * resolves to on PATH.
	 */
	realGpgPath?: string;
}

/**
 * Shell-single-quote a value.
 *
 *   shellQuote(`it's`)  =>  `'it'\''s'`
 *
 * Bash: the sequence `'\''` closes the current single-quoted string, inserts
 * an escaped single quote, and reopens the single-quoted string.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the env-assignment prefix string that, when prepended to a shell
 * command, routes git's gpg.program to our shim with the passfile flow.
 *
 * Example output:
 *
 *   GIT_CONFIG_COUNT='1' \
 *   GIT_CONFIG_KEY_0='gpg.program' \
 *   GIT_CONFIG_VALUE_0='/path/to/shim' \
 *   PI_GPG_PASSFILE='/tmp/pi-gpg-xyz' \
 *   PI_GPG_REAL_GPG='/opt/homebrew/bin/gpg'
 *
 * (rendered on a single line in practice)
 */
export function buildBashEnvPrefix(inj: BashEnvInjection): string {
	const parts: string[] = [
		`GIT_CONFIG_COUNT=${shellQuote("1")}`,
		`GIT_CONFIG_KEY_0=${shellQuote("gpg.program")}`,
		`GIT_CONFIG_VALUE_0=${shellQuote(inj.shimPath)}`,
		`PI_GPG_PASSFILE=${shellQuote(inj.passfilePath)}`,
	];
	if (inj.realGpgPath) {
		parts.push(`PI_GPG_REAL_GPG=${shellQuote(inj.realGpgPath)}`);
	}
	return parts.join(" ");
}

/**
 * Prefix an existing shell command with the env injection.
 *
 * Note: we don't wrap the original in a subshell. Bash-assignment-prefix
 * scoping only applies to the *next* simple command, so for chained commands
 * (`git commit && git push`), only the first command sees our env. That's a
 * feature, not a bug — we want signing env scoped to exactly one git call.
 *
 * If the original is a chain and later parts also need signing, each
 * invocation is detected separately by `analyzeCommand`; the caller can
 * choose to wrap-in-subshell or inject per-segment.
 */
export function prependEnv(command: string, prefix: string): string {
	// Wrap the whole thing in a subshell so the env applies to every segment.
	// Using `(…)` preserves stdin/stdout semantics and cwd for child.
	return `(${prefix} && ${command})`;
}

/**
 * Simpler variant: inject the env prefix *before* the command without a
 * subshell. Useful when we know the command is a single simple invocation
 * (i.e. the detected git call is the whole command).
 */
export function injectSimpleEnv(command: string, prefix: string): string {
	return `${prefix} ${command}`;
}

/**
 * Best-effort replacement: inserts the env prefix inline before the *first*
 * occurrence of `git` at a top-level token boundary. Falls back to
 * `injectSimpleEnv` if no safe boundary is found.
 *
 * This is the safe default for intercepted bash commands, because it:
 *   - preserves the original command's semantics (cd, pipes, etc.)
 *   - scopes the env assignment to only the git invocation
 *   - leaves subsequent commands in a chain untouched
 */
export function injectEnvBeforeGit(command: string, prefix: string): string {
	// Match `\bgit\s` at an unquoted position. Pragmatic — not a full shell parser.
	// The tokenizer in detect.ts is the source of truth for matching; this is a
	// best-effort rewriter for the common case.
	const match = findUnquotedGit(command);
	if (match === -1) return injectSimpleEnv(command, prefix);
	return `${command.slice(0, match)}${prefix} ${command.slice(match)}`;
}

function findUnquotedGit(command: string): number {
	let i = 0;
	const n = command.length;
	while (i < n) {
		const c = command[i]!;
		if (c === "\\" && i + 1 < n) {
			i += 2;
			continue;
		}
		if (c === "'") {
			const close = command.indexOf("'", i + 1);
			if (close === -1) return -1;
			i = close + 1;
			continue;
		}
		if (c === '"') {
			i += 1;
			while (i < n && command[i] !== '"') {
				if (command[i] === "\\" && i + 1 < n) i += 2;
				else i += 1;
			}
			if (i < n) i += 1;
			continue;
		}
		// word boundary check
		if ((i === 0 || /[\s;&|(]/.test(command[i - 1]!)) && command.startsWith("git", i)) {
			const after = command[i + 3];
			if (after === undefined || /\s/.test(after)) return i;
		}
		i += 1;
	}
	return -1;
}

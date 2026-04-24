/**
 * Detect git commands in a shell string that may trigger GPG signing.
 *
 * Philosophy: "over-inclusive but harmless".
 *
 *   - Detection is heuristic (not a full shell parser).
 *   - False positives inject env vars that are ignored if gpg is never called
 *     — zero cost.
 *   - False negatives let a signing attempt reach pinentry — the bug we are
 *     trying to prevent. Err on the side of detecting.
 *
 * Scope of Phase 1:
 *   - `commit`, `tag`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`
 *   - explicit `-S` / `--gpg-sign[=KEY]`, `-s` / `--sign` (tag), `-u KEY`
 *   - explicit disable `--no-gpg-sign`, `--no-sign` (tag)
 *   - implicit signing via `commit.gpgsign=true` / `tag.gpgsign=true`
 *   - global flags before the subcommand: `-c K=V`, `-C dir`, `--git-dir`, `--work-tree`
 *   - leading env assignments and `cd …` chains
 *   - multiple commands joined with `;`, `&&`, `||`, `|`, or newline
 */

export const SIGNING_SUBCOMMANDS = ["commit", "tag", "merge", "rebase", "cherry-pick", "revert", "am"] as const;
export type SigningSubcommand = (typeof SIGNING_SUBCOMMANDS)[number];
const SIGNING_SET: ReadonlySet<string> = new Set<string>(SIGNING_SUBCOMMANDS);

/** Snapshot of the git signing-related config we need to make decisions. */
export interface GitSigningConfigSnapshot {
	commitGpgsign?: boolean;
	tagGpgsign?: boolean;
	userSigningKey?: string;
	/** "openpgp" | "ssh" | "x509" — if "ssh", pi-gpg should not route. */
	gpgFormat?: string;
}

export interface DetectedInvocation {
	subcommand: SigningSubcommand;
	/** The `-S` / `--gpg-sign` / `-s` (tag) / `-u` was present. */
	hasExplicitSign: boolean;
	/** The `--no-gpg-sign` or `--no-sign` (tag) was present. */
	hasExplicitNoSign: boolean;
	/** The tag was annotated (`-a` / `--annotate` / `-s` / `-u` / `-m`). */
	hasAnnotatedTagFlag: boolean;
	/** KEY from `-S KEY`, `--gpg-sign=KEY`, or `-u KEY`. */
	explicitKeyid?: string;
	/** Whether we believe this invocation will ask gpg to sign. */
	willSign: boolean;
}

export interface DetectionResult {
	/** All git-signing-capable invocations in the string. */
	invocations: DetectedInvocation[];
	/** True if ANY invocation is expected to sign. */
	willSign: boolean;
	/** True if the SSH backend is in use — pi-gpg should not route in this case. */
	sshBackend: boolean;
}

// ---------------------------------------------------------------------------
// Tokenization (small, deliberately minimal)
// ---------------------------------------------------------------------------

interface Token {
	text: string;
	/** Raw span in the source string (for later rewriting). */
	start: number;
	end: number;
	/** True if this token is an unquoted shell separator like `;` or `&&`. */
	separator?: true;
}

const SEPARATORS = ["&&", "||", ";", "|", "\n"] as const;

/**
 * Token split that respects single- and double-quoted strings and backslash
 * escapes. Quotes are NOT stripped — the output tokens preserve the quoting so
 * that round-tripping a segment back to the shell is safe.
 */
export function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = command.length;

	const pushSep = (text: string, start: number) => {
		tokens.push({ text, start, end: start + text.length, separator: true });
	};

	while (i < n) {
		const ch = command[i]!;

		// Skip ordinary whitespace (NOT newlines — they are separators).
		if (ch === " " || ch === "\t" || ch === "\r") {
			i += 1;
			continue;
		}

		// Comments — treat `#` at start-of-token as a line comment.
		if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
			while (i < n && command[i] !== "\n") i += 1;
			continue;
		}

		// Separators.
		let matched: string | null = null;
		for (const sep of SEPARATORS) {
			if (command.startsWith(sep, i)) {
				matched = sep;
				break;
			}
		}
		if (matched) {
			pushSep(matched, i);
			i += matched.length;
			continue;
		}

		// Regular token — read until next separator/whitespace, honoring quotes.
		const start = i;
		let buf = "";
		while (i < n) {
			const c = command[i]!;

			// End-of-token on unquoted whitespace/separators.
			if (c === " " || c === "\t" || c === "\r" || c === "\n") break;
			let sepHit = false;
			for (const sep of SEPARATORS) {
				if (command.startsWith(sep, i)) {
					sepHit = true;
					break;
				}
			}
			if (sepHit) break;

			if (c === "\\" && i + 1 < n) {
				buf += command[i + 1];
				i += 2;
				continue;
			}
			if (c === "'") {
				const close = command.indexOf("'", i + 1);
				if (close === -1) {
					buf += command.slice(i + 1);
					i = n;
					break;
				}
				buf += command.slice(i + 1, close);
				i = close + 1;
				continue;
			}
			if (c === '"') {
				i += 1;
				while (i < n && command[i] !== '"') {
					if (command[i] === "\\" && i + 1 < n) {
						buf += command[i + 1];
						i += 2;
					} else {
						buf += command[i];
						i += 1;
					}
				}
				if (i < n) i += 1; // closing quote
				continue;
			}
			buf += c;
			i += 1;
		}
		tokens.push({ text: buf, start, end: i });
	}

	return tokens;
}

function splitSegments(tokens: Token[]): Token[][] {
	const segments: Token[][] = [];
	let current: Token[] = [];
	for (const tok of tokens) {
		if (tok.separator) {
			if (current.length > 0) {
				segments.push(current);
				current = [];
			}
		} else {
			current.push(tok);
		}
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

// Matches `KEY=VALUE` (shell env assignment).
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripLeadingEnvAndNoOps(seg: Token[]): Token[] {
	let i = 0;
	while (i < seg.length && ENV_ASSIGN_RE.test(seg[i]!.text)) i += 1;
	return seg.slice(i);
}

/** Global git flags that precede the subcommand. Those taking an argument consume one extra token. */
const GIT_GLOBAL_FLAGS_WITH_ARG = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const GIT_GLOBAL_FLAGS_STANDALONE = new Set([
	"--bare",
	"--no-pager",
	"--paginate",
	"--no-replace-objects",
	"--literal-pathspecs",
]);

interface PostGitCursor {
	/** Index of the subcommand token in the segment. */
	subcommandIdx: number;
}

function findSubcommand(seg: Token[], gitIdx: number): PostGitCursor | null {
	let j = gitIdx + 1;
	while (j < seg.length) {
		const t = seg[j]!.text;
		if (t.startsWith("--") && t.includes("=")) {
			const name = t.slice(0, t.indexOf("="));
			if (GIT_GLOBAL_FLAGS_WITH_ARG.has(name) || GIT_GLOBAL_FLAGS_STANDALONE.has(name)) {
				j += 1;
				continue;
			}
			// unknown `--foo=bar` before subcommand — treat as unknown, bail.
			return null;
		}
		if (GIT_GLOBAL_FLAGS_WITH_ARG.has(t)) {
			j += 2;
			continue;
		}
		if (GIT_GLOBAL_FLAGS_STANDALONE.has(t)) {
			j += 1;
			continue;
		}
		// Anything else is the subcommand (or a positional that means "not a signing command").
		return { subcommandIdx: j };
	}
	return null;
}

function detectGitSegment(seg: Token[]): DetectedInvocation | null {
	const cleaned = stripLeadingEnvAndNoOps(seg);
	if (cleaned.length < 2 || cleaned[0]!.text !== "git") return null;

	const cursor = findSubcommand(cleaned, 0);
	if (!cursor) return null;
	const subToken = cleaned[cursor.subcommandIdx];
	if (!subToken) return null;
	const sub = subToken.text;
	if (!SIGNING_SET.has(sub)) return null;
	const subcommand = sub as SigningSubcommand;

	const subArgs = cleaned.slice(cursor.subcommandIdx + 1).map((t) => t.text);

	let hasExplicitSign = false;
	let hasExplicitNoSign = false;
	let hasAnnotatedTagFlag = false;
	let explicitKeyid: string | undefined;

	for (let i = 0; i < subArgs.length; i += 1) {
		const arg = subArgs[i]!;
		// commit / merge / rebase / cherry-pick / revert / am: -S, --gpg-sign, --no-gpg-sign
		if (arg === "--no-gpg-sign" || (subcommand === "tag" && arg === "--no-sign")) {
			hasExplicitNoSign = true;
			continue;
		}
		if (arg === "-S") {
			hasExplicitSign = true;
			// Optional inline arg: `-S KEYID` (but only if the next token is not a flag).
			const next = subArgs[i + 1];
			if (next && !next.startsWith("-")) {
				explicitKeyid = next;
				i += 1;
			}
			continue;
		}
		if (arg.startsWith("-S")) {
			// `-SKEYID` — concatenated.
			hasExplicitSign = true;
			explicitKeyid = arg.slice(2);
			continue;
		}
		if (arg === "--gpg-sign") {
			hasExplicitSign = true;
			continue;
		}
		if (arg.startsWith("--gpg-sign=")) {
			hasExplicitSign = true;
			explicitKeyid = arg.slice("--gpg-sign=".length);
			continue;
		}
		if (subcommand === "tag" && (arg === "-s" || arg === "--sign")) {
			hasExplicitSign = true;
			hasAnnotatedTagFlag = true;
			continue;
		}
		if (subcommand === "tag" && (arg === "-a" || arg === "--annotate")) {
			hasAnnotatedTagFlag = true;
			continue;
		}
		if (subcommand === "tag" && (arg === "-m" || arg.startsWith("-m") || arg.startsWith("--message"))) {
			// -m implies -a per git docs.
			hasAnnotatedTagFlag = true;
			continue;
		}
		if (arg === "-u" || arg === "--local-user") {
			const next = subArgs[i + 1];
			if (next && !next.startsWith("-")) {
				explicitKeyid = next;
				i += 1;
			}
			continue;
		}
		if (arg.startsWith("-u")) {
			explicitKeyid = arg.slice(2);
			continue;
		}
		if (arg.startsWith("--local-user=")) {
			explicitKeyid = arg.slice("--local-user=".length);
		}
	}

	return {
		subcommand,
		hasExplicitSign,
		hasExplicitNoSign,
		hasAnnotatedTagFlag,
		explicitKeyid,
		willSign: false, // caller fills this in via config
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function analyzeCommand(command: string, cfg: GitSigningConfigSnapshot = {}): DetectionResult {
	const tokens = tokenize(command);
	const segments = splitSegments(tokens);

	const invocations: DetectedInvocation[] = [];
	for (const seg of segments) {
		const detected = detectGitSegment(seg);
		if (!detected) continue;
		detected.willSign = decideWillSign(detected, cfg);
		invocations.push(detected);
	}

	const sshBackend = cfg.gpgFormat === "ssh";
	const willSign = invocations.some((i) => i.willSign) && !sshBackend;
	return { invocations, willSign, sshBackend };
}

function decideWillSign(d: DetectedInvocation, cfg: GitSigningConfigSnapshot): boolean {
	if (d.hasExplicitNoSign) return false;
	if (d.hasExplicitSign) return true;
	switch (d.subcommand) {
		case "commit":
		case "merge":
		case "rebase":
		case "cherry-pick":
		case "revert":
		case "am":
			return cfg.commitGpgsign === true;
		case "tag":
			// Non-annotated tags never sign.
			if (!d.hasAnnotatedTagFlag) return false;
			return cfg.tagGpgsign === true;
	}
}

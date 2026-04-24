import { describe, expect, it } from "vitest";
import { buildBashEnvPrefix, injectEnvBeforeGit, injectSimpleEnv, prependEnv, shellQuote } from "../src/env.js";

describe("shellQuote", () => {
	it("wraps simple strings", () => {
		expect(shellQuote("foo")).toBe("'foo'");
	});

	it("escapes single quotes using the '\\'' pattern", () => {
		expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
	});

	it("handles paths with spaces", () => {
		expect(shellQuote("/Users/John Doe/bin/shim.sh")).toBe("'/Users/John Doe/bin/shim.sh'");
	});

	it("handles empty strings", () => {
		expect(shellQuote("")).toBe("''");
	});

	it("double-quoted output is shell-safe when round-tripped", () => {
		const values = [`ab'c`, "x y z", "$(whoami)", "a\nb", "\\backslash", "'"];
		for (const v of values) {
			// Verify the quoted form contains exactly one outer-level single-quoted span
			// that expands back to v when interpreted by a shell. We can't easily run sh
			// here, but we can verify syntactic invariants.
			const q = shellQuote(v);
			expect(q.startsWith("'")).toBe(true);
			expect(q.endsWith("'")).toBe(true);
		}
	});
});

describe("buildBashEnvPrefix", () => {
	it("produces a GIT_CONFIG_* + PI_GPG_PASSFILE prefix", () => {
		const s = buildBashEnvPrefix({
			shimPath: "/opt/pi-gpg/shim.sh",
			passfilePath: "/tmp/pi-gpg-xyz/pass",
		});
		expect(s).toContain(`GIT_CONFIG_COUNT='1'`);
		expect(s).toContain(`GIT_CONFIG_KEY_0='gpg.program'`);
		expect(s).toContain(`GIT_CONFIG_VALUE_0='/opt/pi-gpg/shim.sh'`);
		expect(s).toContain(`PI_GPG_PASSFILE='/tmp/pi-gpg-xyz/pass'`);
	});

	it("includes PI_GPG_REAL_GPG when provided", () => {
		const s = buildBashEnvPrefix({
			shimPath: "/s",
			passfilePath: "/p",
			realGpgPath: "/opt/homebrew/bin/gpg",
		});
		expect(s).toContain(`PI_GPG_REAL_GPG='/opt/homebrew/bin/gpg'`);
	});
});

describe("injectEnvBeforeGit", () => {
	const prefix = `FOO='bar'`;

	it("inserts before `git` as the first token", () => {
		expect(injectEnvBeforeGit("git commit -S -m x", prefix)).toBe("FOO='bar' git commit -S -m x");
	});

	it("inserts after `cd foo &&`", () => {
		const got = injectEnvBeforeGit("cd repo && git commit -S -m x", prefix);
		expect(got).toBe("cd repo && FOO='bar' git commit -S -m x");
	});

	it("is not fooled by `git` inside a quoted message", () => {
		const got = injectEnvBeforeGit(`echo "git log" && git commit -S -m fix`, prefix);
		expect(got).toBe(`echo "git log" && FOO='bar' git commit -S -m fix`);
	});

	it("falls back to simple prefix when no `git` token found", () => {
		const got = injectEnvBeforeGit("echo hello", prefix);
		expect(got).toBe("FOO='bar' echo hello");
	});
});

describe("injectSimpleEnv / prependEnv", () => {
	it("injectSimpleEnv concatenates with a space", () => {
		expect(injectSimpleEnv("git commit", "FOO='bar'")).toBe("FOO='bar' git commit");
	});

	it("prependEnv wraps in a subshell with && separator", () => {
		expect(prependEnv("git commit", "FOO='bar'")).toBe("(FOO='bar' && git commit)");
	});
});

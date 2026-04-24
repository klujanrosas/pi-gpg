import { describe, expect, it } from "vitest";
import { analyzeCommand, tokenize } from "../src/detect.js";

describe("tokenize", () => {
	it("splits simple commands", () => {
		const t = tokenize("git commit -m hello").filter((x) => !x.separator);
		expect(t.map((x) => x.text)).toEqual(["git", "commit", "-m", "hello"]);
	});

	it("keeps quoted spans intact", () => {
		const t = tokenize(`git commit -m "fix: don't break; do right" -S`).filter((x) => !x.separator);
		expect(t.map((x) => x.text)).toEqual(["git", "commit", "-m", "fix: don't break; do right", "-S"]);
	});

	it("splits on shell separators", () => {
		const t = tokenize("git add . && git commit -S -m 'msg'");
		const seps = t.filter((x) => x.separator).map((x) => x.text);
		expect(seps).toEqual(["&&"]);
	});

	it("treats quoted separators as tokens, not splits", () => {
		const t = tokenize(`git commit -m "a; b && c"`).filter((x) => x.separator);
		expect(t).toEqual([]);
	});
});

describe("analyzeCommand — commit", () => {
	it("detects explicit -S", () => {
		const r = analyzeCommand("git commit -S -m fix");
		expect(r.willSign).toBe(true);
		expect(r.invocations).toHaveLength(1);
		expect(r.invocations[0]).toMatchObject({
			subcommand: "commit",
			hasExplicitSign: true,
			hasExplicitNoSign: false,
			willSign: true,
		});
	});

	it("detects --gpg-sign=KEYID and parses the key", () => {
		const r = analyzeCommand("git commit --gpg-sign=ABCDEF0123456789 -m x");
		expect(r.invocations[0]?.explicitKeyid).toBe("ABCDEF0123456789");
		expect(r.invocations[0]?.hasExplicitSign).toBe(true);
		expect(r.willSign).toBe(true);
	});

	it("detects -SKEYID concatenated form", () => {
		const r = analyzeCommand("git commit -SABCDEF0123456789 -m x");
		expect(r.invocations[0]?.explicitKeyid).toBe("ABCDEF0123456789");
		expect(r.willSign).toBe(true);
	});

	it("detects -u KEYID", () => {
		const r = analyzeCommand("git commit -u ABCDEF0123456789 -m x");
		expect(r.invocations[0]?.explicitKeyid).toBe("ABCDEF0123456789");
	});

	it("respects --no-gpg-sign even when config says sign", () => {
		const r = analyzeCommand("git commit --no-gpg-sign -m x", { commitGpgsign: true });
		expect(r.invocations[0]?.hasExplicitNoSign).toBe(true);
		expect(r.willSign).toBe(false);
	});

	it("uses commit.gpgsign config when -S is absent", () => {
		const withSign = analyzeCommand("git commit -m x", { commitGpgsign: true });
		expect(withSign.willSign).toBe(true);
		const without = analyzeCommand("git commit -m x", { commitGpgsign: false });
		expect(without.willSign).toBe(false);
	});
});

describe("analyzeCommand — tag", () => {
	it("detects `git tag -s`", () => {
		const r = analyzeCommand("git tag -s v1.0 -m release");
		expect(r.invocations[0]?.hasExplicitSign).toBe(true);
		expect(r.invocations[0]?.hasAnnotatedTagFlag).toBe(true);
		expect(r.willSign).toBe(true);
	});

	it("does not sign a lightweight tag when tag.gpgsign=true", () => {
		// Lightweight tag = no -a/-s/-m: never signs.
		const r = analyzeCommand("git tag v1.0", { tagGpgsign: true });
		expect(r.willSign).toBe(false);
	});

	it("signs annotated tag when tag.gpgsign=true", () => {
		const r = analyzeCommand("git tag -a v1.0 -m release", { tagGpgsign: true });
		expect(r.invocations[0]?.hasAnnotatedTagFlag).toBe(true);
		expect(r.willSign).toBe(true);
	});

	it("respects --no-sign on tag", () => {
		const r = analyzeCommand("git tag -a v1.0 --no-sign -m x", { tagGpgsign: true });
		expect(r.willSign).toBe(false);
	});
});

describe("analyzeCommand — merge / rebase / cherry-pick / revert / am", () => {
	for (const sub of ["merge", "rebase", "cherry-pick", "revert", "am"] as const) {
		it(`${sub} signs when commit.gpgsign=true`, () => {
			const r = analyzeCommand(`git ${sub} main`, { commitGpgsign: true });
			expect(r.willSign).toBe(true);
			expect(r.invocations[0]?.subcommand).toBe(sub);
		});
		it(`${sub} signs with -S`, () => {
			const r = analyzeCommand(`git ${sub} -S main`);
			expect(r.willSign).toBe(true);
		});
		it(`${sub} does not sign without flags or config`, () => {
			const r = analyzeCommand(`git ${sub} main`);
			expect(r.willSign).toBe(false);
		});
	}
});

describe("analyzeCommand — environment & SSH backend", () => {
	it("SSH backend disables routing regardless of flags", () => {
		const r = analyzeCommand("git commit -S -m x", { commitGpgsign: true, gpgFormat: "ssh" });
		expect(r.willSign).toBe(false);
		expect(r.sshBackend).toBe(true);
	});

	it("handles global flags before subcommand", () => {
		const r = analyzeCommand("git -c foo=bar -C /tmp commit -S -m msg");
		expect(r.invocations).toHaveLength(1);
		expect(r.invocations[0]?.subcommand).toBe("commit");
		expect(r.invocations[0]?.hasExplicitSign).toBe(true);
	});

	it("skips leading env assignments", () => {
		const r = analyzeCommand("GPG_TTY=$(tty) HOME=/tmp git commit -S -m x");
		expect(r.willSign).toBe(true);
		expect(r.invocations[0]?.subcommand).toBe("commit");
	});

	it("ignores non-signing subcommands", () => {
		const r = analyzeCommand("git push origin main", { commitGpgsign: true });
		expect(r.invocations).toHaveLength(0);
		expect(r.willSign).toBe(false);
	});

	it("detects multiple git invocations in a chain", () => {
		const r = analyzeCommand("git add . && git commit -S -m fix && git push");
		expect(r.invocations).toHaveLength(1);
		expect(r.invocations[0]?.subcommand).toBe("commit");
	});

	it("detects in semicolon chains", () => {
		const r = analyzeCommand("git add . ; git commit -S -m x ; echo done");
		expect(r.invocations).toHaveLength(1);
		expect(r.willSign).toBe(true);
	});

	it("handles newline-separated commands", () => {
		const cmd = ["git add .", "git commit -S -m 'fix'"].join("\n");
		const r = analyzeCommand(cmd);
		expect(r.invocations).toHaveLength(1);
		expect(r.willSign).toBe(true);
	});

	it("is not fooled by `git` appearing inside a quoted message", () => {
		const r = analyzeCommand(`git commit -m "mentioned git commit here" -S`);
		expect(r.invocations).toHaveLength(1);
		expect(r.invocations[0]?.hasExplicitSign).toBe(true);
	});

	it("is not fooled by an unrelated `git` substring", () => {
		const r = analyzeCommand("echo 'git commit -S' > /dev/null");
		// Our tokenizer treats the `-S` inside single quotes as a single token,
		// but the first token is `echo`, not `git` — so no invocation.
		expect(r.invocations).toHaveLength(0);
	});
});

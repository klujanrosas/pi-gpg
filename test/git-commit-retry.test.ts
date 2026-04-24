/**
 * Unit tests for the `git_commit` tool's retry-on-bad-passphrase behavior.
 *
 * We mock `runGitWithFd3Passphrase` so we never spawn a real git, and we
 * supply a fake `ExtensionContext.ui.input` that returns a scripted sequence
 * of passphrases. The tool should:
 *
 *   - retry up to 3 *user-visible* prompts on bad passphrase
 *   - invalidate the cache between attempts so each retry prompts fresh
 *   - treat a cache-hit failure as "free" (doesn't consume a prompt attempt)
 *   - abort immediately if the user cancels the prompt
 *   - abort immediately on a non-passphrase error
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassphraseCache } from "../src/cache.js";
import { createGitCommitTool, isLikelyBadPassphrase } from "../src/tools/git-commit.js";

// Hoist the mock state so vi.mock() can close over it.
const { gitMock } = vi.hoisted(() => ({
	gitMock: vi.fn(),
}));

vi.mock("../src/gpg.js", async () => {
	return {
		runGitWithFd3Passphrase: gitMock,
		zeroize: (buf: Buffer) => buf.fill(0),
	};
});

vi.mock("../src/keys.js", () => ({
	resolveSigningKey: vi.fn(async (_exec: unknown, opts: { explicitKeyid?: string }) => ({
		keyid: opts.explicitKeyid ?? "ABCD1234DEADBEEF",
		display: "ABCD1234DEADBEEF",
	})),
}));

interface MockCtx {
	cwd: string;
	hasUI: boolean;
	ui: {
		input: ReturnType<typeof vi.fn>;
		notify: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
	};
}

function makeCtx(inputResults: (string | undefined)[]): MockCtx {
	const input = vi.fn();
	for (const value of inputResults) input.mockResolvedValueOnce(value);
	return {
		cwd: "/tmp/fake",
		hasUI: true,
		ui: {
			input,
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
	};
}

function makeTool() {
	const cache = new PassphraseCache();
	const tool = createGitCommitTool({
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })) as never,
		cache,
		shimPath: "/fake/shim",
	});
	return { tool, cache };
}

describe("isLikelyBadPassphrase", () => {
	it("matches explicit gpg markers", () => {
		expect(isLikelyBadPassphrase("gpg: signing failed: Bad passphrase")).toBe(true);
		expect(isLikelyBadPassphrase("Bad passphrase")).toBe(true);
		expect(isLikelyBadPassphrase("passphrase is incorrect")).toBe(true);
	});

	it("matches git's generic signing-failure wrapper", () => {
		// The exact output the user reported when the cached passphrase went stale:
		const reported = "error: gpg failed to sign the data\nfatal: failed to write commit object";
		expect(isLikelyBadPassphrase(reported)).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isLikelyBadPassphrase("fatal: not a git repository")).toBe(false);
		expect(isLikelyBadPassphrase("nothing to commit, working tree clean")).toBe(false);
		expect(isLikelyBadPassphrase("")).toBe(false);
	});
});

describe("git_commit retry loop", () => {
	beforeEach(() => {
		gitMock.mockReset();
	});

	it("retries up to 3 prompts on bad passphrase, then fails", async () => {
		// Three bad passphrases, all rejected by git.
		gitMock.mockResolvedValue({
			code: 1,
			stdout: "",
			stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object",
		});

		const { tool, cache } = makeTool();
		const ctx = makeCtx(["wrong1", "wrong2", "wrong3"]);

		await expect(tool.execute("call-1", { message: "test" }, undefined, undefined, ctx as never)).rejects.toThrow(
			/bad passphrase.*after 3 attempts/i,
		);

		// Three prompts shown.
		expect(ctx.ui.input).toHaveBeenCalledTimes(3);
		// Three git attempts made.
		expect(gitMock).toHaveBeenCalledTimes(3);
		// First title plain, subsequent retries labelled.
		const calls = ctx.ui.input.mock.calls;
		expect(calls[0]?.[0]).toMatch(/pi-gpg passphrase/);
		expect(calls[1]?.[0]).toMatch(/retry 2\/3/);
		expect(calls[2]?.[0]).toMatch(/retry 3\/3/);
		// Cache is empty after failure.
		expect(cache.stats().size).toBe(0);
	});

	it("succeeds on the 2nd prompt and caches the working passphrase", async () => {
		gitMock
			.mockResolvedValueOnce({
				code: 1,
				stdout: "",
				stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object",
			})
			.mockResolvedValueOnce({
				code: 0,
				stdout: "[main abc1234] test\n",
				stderr: "",
			});

		const { tool, cache } = makeTool();
		const ctx = makeCtx(["wrong", "right"]);

		const result = (await tool.execute("call-1", { message: "test" }, undefined, undefined, ctx as never)) as {
			details: { attempts: number; fromCache: boolean };
		};

		expect(result.details.attempts).toBe(2);
		expect(ctx.ui.input).toHaveBeenCalledTimes(2);
		expect(gitMock).toHaveBeenCalledTimes(2);
		// Good passphrase is now cached.
		expect(cache.stats().size).toBe(1);
	});

	it("treats a stale cache-hit failure as a free retry (doesn't count toward 3)", async () => {
		// The cache will hand us a stale passphrase on attempt 1. That fails,
		// we invalidate it, and then we get our full 3 prompt attempts.
		const { tool, cache } = makeTool();
		cache.put("ABCD1234DEADBEEF", Buffer.from("stale-cached"));

		gitMock.mockResolvedValue({
			code: 1,
			stdout: "",
			stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object",
		});

		const ctx = makeCtx(["wrong1", "wrong2", "wrong3"]);

		await expect(tool.execute("call-1", { message: "test" }, undefined, undefined, ctx as never)).rejects.toThrow(
			/bad passphrase.*after 3 attempts/i,
		);

		// 3 prompts (cache attempt was "free") + 1 cache attempt = 4 git calls.
		expect(ctx.ui.input).toHaveBeenCalledTimes(3);
		expect(gitMock).toHaveBeenCalledTimes(4);
	});

	it("aborts immediately when the user cancels the prompt", async () => {
		gitMock.mockResolvedValue({
			code: 1,
			stdout: "",
			stderr: "error: gpg failed to sign the data\nfatal: failed to write commit object",
		});

		const { tool } = makeTool();
		// `undefined` == user dismissed the input dialog.
		const ctx = makeCtx([undefined]);

		await expect(tool.execute("call-1", { message: "test" }, undefined, undefined, ctx as never)).rejects.toThrow(
			/cancelled/i,
		);

		expect(ctx.ui.input).toHaveBeenCalledTimes(1);
		expect(gitMock).not.toHaveBeenCalled();
	});

	it("does not retry on non-passphrase errors", async () => {
		gitMock.mockResolvedValue({
			code: 128,
			stdout: "",
			stderr: "fatal: not a git repository",
		});

		const { tool } = makeTool();
		const ctx = makeCtx(["anything"]);

		await expect(tool.execute("call-1", { message: "test" }, undefined, undefined, ctx as never)).rejects.toThrow(
			/git exited 128/,
		);

		expect(ctx.ui.input).toHaveBeenCalledTimes(1);
		expect(gitMock).toHaveBeenCalledTimes(1);
	});

	it("on first-try success, uses the cached passphrase with zero prompts", async () => {
		gitMock.mockResolvedValue({
			code: 0,
			stdout: "[main deadbee] ok\n",
			stderr: "",
		});

		const { tool, cache } = makeTool();
		cache.put("ABCD1234DEADBEEF", Buffer.from("good-cached"));

		const ctx = makeCtx([]);

		const result = (await tool.execute("call-1", { message: "test" }, undefined, undefined, ctx as never)) as {
			details: { attempts: number; fromCache: boolean };
		};

		expect(result.details.fromCache).toBe(true);
		expect(result.details.attempts).toBe(0);
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(gitMock).toHaveBeenCalledTimes(1);
	});
});

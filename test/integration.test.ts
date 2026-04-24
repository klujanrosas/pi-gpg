/**
 * End-to-end integration: create an ephemeral GNUPGHOME with a throwaway
 * key, stand up a tiny git repo, sign a commit through the fd-3 passphrase
 * flow, and verify the commit.
 *
 * Skipped automatically when:
 *   - gpg is not on PATH
 *   - git is not on PATH
 *   - PI_GPG_SKIP_INTEGRATION=1
 *
 * Real integration — we spawn real gpg and real git. No mocks.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGitWithFd3Passphrase } from "../src/gpg.js";

const PASSPHRASE = "correct horse battery staple";
const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = resolve(HERE, "..", "shim", "gpg-loopback.sh");

function has(bin: string): boolean {
	try {
		execFileSync("which", [bin], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const skip = !has("gpg") || !has("git") || process.env.PI_GPG_SKIP_INTEGRATION === "1";

describe.skipIf(skip)("integration — fd-3 signed commit", () => {
	it("signs a commit and verifies it without touching pinentry", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "pi-gpg-it-"));
		const gnupgHome = join(tmp, "gnupg");
		const repo = join(tmp, "repo");
		const batchFile = join(tmp, "batch");
		try {
			execFileSync("mkdir", ["-p", gnupgHome], { stdio: "ignore" });
			execFileSync("chmod", ["700", gnupgHome], { stdio: "ignore" });

			// Generate a throwaway key in the ephemeral GNUPGHOME. `--batch` is
			// fine here — WE are choosing the passphrase, not asking for it.
			await writeFile(
				batchFile,
				[
					"Key-Type: eddsa",
					"Key-Curve: ed25519",
					"Name-Real: pi-gpg test",
					"Name-Email: pi-gpg-test@example.invalid",
					"Expire-Date: 0",
					`Passphrase: ${PASSPHRASE}`,
					"%commit",
				].join("\n"),
			);
			execFileSync(
				"gpg",
				["--homedir", gnupgHome, "--batch", "--pinentry-mode", "loopback", "--gen-key", batchFile],
				{ stdio: "ignore" },
			);

			// Find the keyid.
			const listing = execFileSync("gpg", ["--homedir", gnupgHome, "--list-secret-keys", "--with-colons"], {
				encoding: "utf8",
			});
			const secLine = listing.split("\n").find((l) => l.startsWith("sec:"));
			const keyid = secLine?.split(":")[4];
			expect(keyid).toBeTruthy();

			// Set up a tiny git repo in $repo.
			execFileSync("mkdir", ["-p", repo], { stdio: "ignore" });
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
			execFileSync("git", ["config", "user.name", "pi-gpg test"], { cwd: repo });
			execFileSync("git", ["config", "user.email", "pi-gpg-test@example.invalid"], { cwd: repo });
			execFileSync("git", ["config", "user.signingkey", keyid!], { cwd: repo });
			await writeFile(join(repo, "README.md"), "# hello\n");
			execFileSync("git", ["add", "README.md"], { cwd: repo });

			// THE ACTUAL TEST: call our fd-3 runner directly.
			const result = await runGitWithFd3Passphrase({
				args: ["commit", "-S", "-m", "pi-gpg integration test commit", "--no-verify"],
				shimPath: SHIM_PATH,
				cwd: repo,
				env: { GNUPGHOME: gnupgHome },
				passphrase: Buffer.from(PASSPHRASE),
			});

			if (result.code !== 0) {
				// Surface the child process output so a CI failure is diagnosable.
				throw new Error(`git exited ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
			}

			// Directly inspect the commit object — signed commits carry a `gpgsig`
			// header before the commit message body.
			const raw = execFileSync("git", ["cat-file", "-p", "HEAD"], { cwd: repo, encoding: "utf8" });
			expect(raw).toMatch(/^gpgsig /m);
			expect(raw).toContain("-----BEGIN PGP SIGNATURE-----");
			expect(raw).toContain("-----END PGP SIGNATURE-----");

			// And verify-commit should agree. Use spawnSync so we can grab stderr
			// (the `gpg: Good signature` output goes to stderr, not stdout).
			const { spawnSync } = await import("node:child_process");
			const verify = spawnSync("git", ["verify-commit", "HEAD"], {
				cwd: repo,
				env: { ...process.env, GNUPGHOME: gnupgHome },
				encoding: "utf8",
			});
			const verifyOutput = `${verify.stdout}\n${verify.stderr}`;
			expect(verify.status).toBe(0);
			expect(verifyOutput).toMatch(/Good signature/i);

			// Sanity: the commit message survived.
			const log = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: repo, encoding: "utf8" });
			expect(log.trim()).toBe("pi-gpg integration test commit");

			// Sanity: no passphrase file leaked (fd-3 path writes nothing to disk).
			const files = execFileSync("find", [tmp, "-name", "pass", "-type", "f"], { encoding: "utf8" });
			expect(files.trim()).toBe("");

			// Sanity: the README we wrote is present in the commit.
			const content = await readFile(join(repo, "README.md"), "utf8");
			expect(content).toContain("hello");
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}, 30_000);

	it("reports a useful error on bad passphrase", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "pi-gpg-it-"));
		const gnupgHome = join(tmp, "gnupg");
		const repo = join(tmp, "repo");
		const batchFile = join(tmp, "batch");
		try {
			execFileSync("mkdir", ["-p", gnupgHome], { stdio: "ignore" });
			execFileSync("chmod", ["700", gnupgHome], { stdio: "ignore" });

			await writeFile(
				batchFile,
				[
					"Key-Type: eddsa",
					"Key-Curve: ed25519",
					"Name-Real: pi-gpg bad-pass test",
					"Name-Email: pi-gpg-bad@example.invalid",
					"Expire-Date: 0",
					`Passphrase: ${PASSPHRASE}`,
					"%commit",
				].join("\n"),
			);
			execFileSync(
				"gpg",
				["--homedir", gnupgHome, "--batch", "--pinentry-mode", "loopback", "--gen-key", batchFile],
				{ stdio: "ignore" },
			);
			const listing = execFileSync("gpg", ["--homedir", gnupgHome, "--list-secret-keys", "--with-colons"], {
				encoding: "utf8",
			});
			const keyid = listing
				.split("\n")
				.find((l) => l.startsWith("sec:"))
				?.split(":")[4];
			if (!keyid) throw new Error("test: failed to generate gpg key");

			execFileSync("mkdir", ["-p", repo], { stdio: "ignore" });
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
			execFileSync("git", ["config", "user.name", "x"], { cwd: repo });
			execFileSync("git", ["config", "user.email", "x@y"], { cwd: repo });
			execFileSync("git", ["config", "user.signingkey", keyid], { cwd: repo });
			await writeFile(join(repo, "file"), "x");
			execFileSync("git", ["add", "file"], { cwd: repo });

			const result = await runGitWithFd3Passphrase({
				args: ["commit", "-S", "-m", "should fail"],
				shimPath: SHIM_PATH,
				cwd: repo,
				env: { GNUPGHOME: gnupgHome },
				passphrase: Buffer.from("wrong-passphrase"),
			});
			expect(result.code).not.toBe(0);
			const combined = `${result.stdout}\n${result.stderr}`;
			expect(combined).toMatch(/bad passphrase|failed to sign|signing failed/i);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}, 30_000);
});

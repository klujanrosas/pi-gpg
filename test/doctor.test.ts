import { describe, expect, it } from "vitest";
import {
	type DoctorReport,
	diagnose,
	parseColonKeys,
	parseGpgVersion,
	renderReport,
	runDoctor,
} from "../src/doctor.js";
import type { ExecFn } from "../src/exec.js";

// ---------------------------------------------------------------------------
// parseGpgVersion
// ---------------------------------------------------------------------------

describe("parseGpgVersion", () => {
	it("extracts the semver from a real gpg --version header", () => {
		expect(parseGpgVersion("gpg (GnuPG) 2.4.5\nlibgcrypt 1.10.3\n")).toBe("2.4.5");
	});

	it("returns null on empty input", () => {
		expect(parseGpgVersion("")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseColonKeys
// ---------------------------------------------------------------------------

describe("parseColonKeys", () => {
	it("parses a valid secret key listing", () => {
		const fixture = [
			"sec:u:4096:1:ABCDEF0123456789:1700000000:1900000000::u:::scESC:::+::::23::0:",
			"fpr:::::::::AAAABBBBCCCCDDDDEEEEFFFF0000111122223333:",
			"uid:u::::1700000000::abcd1234::Jane Doe <jane@example.com>::::::::::0:",
			"ssb:u:4096:1:1111222233334444:1700000000::::::e:::+:::23:",
			"",
		].join("\n");

		const keys = parseColonKeys(fixture);
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({
			keyid: "ABCDEF0123456789",
			fingerprint: "AAAABBBBCCCCDDDDEEEEFFFF0000111122223333",
			uids: ["Jane Doe <jane@example.com>"],
			expired: false,
		});
		expect(keys[0]?.created).toBe(new Date(1_700_000_000 * 1000).toISOString());
		expect(keys[0]?.expires).toBe(new Date(1_900_000_000 * 1000).toISOString());
	});

	it("marks expired keys by validity flag", () => {
		const fixture = [
			"sec:e:4096:1:DEADBEEFDEADBEEF:1500000000:1600000000::u:::scESC:::+::::23::0:",
			"fpr:::::::::0000111122223333444455556666777788889999:",
			"uid:u::::1500000000::abcd1234::Expired Person <old@example.com>::::::::::0:",
		].join("\n");

		const keys = parseColonKeys(fixture);
		expect(keys[0]?.expired).toBe(true);
	});

	it("unescapes colon-field special chars", () => {
		const fixture = [
			"sec:u:4096:1:ABCDEF0123456789:1700000000:0::u:::scESC:::+::::23::0:",
			"fpr:::::::::AAAABBBBCCCCDDDDEEEEFFFF0000111122223333:",
			"uid:u::::1700000000::abcd1234::Weird\\x3aName <x@y>::::::::::0:",
		].join("\n");

		const keys = parseColonKeys(fixture);
		expect(keys[0]?.uids[0]).toBe("Weird:Name <x@y>");
	});

	it("returns [] on empty input", () => {
		expect(parseColonKeys("")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// diagnose
// ---------------------------------------------------------------------------

describe("diagnose", () => {
	const baseReport = (): DoctorReport => ({
		cwd: "/tmp/test",
		gpg: { path: "/opt/homebrew/bin/gpg", version: "2.4.5" },
		agentConf: { path: "/dev/null", exists: false, pinentryProgram: null, defaultCacheTtl: null, maxCacheTtl: null },
		pinentry: { found: {}, default: null },
		git: {
			global: {},
			repo: {},
			effective: {},
			willAutoSignCommits: false,
			willAutoSignTags: false,
		},
		keys: [],
		findings: [],
	});

	it("flags gpg missing", () => {
		const r = baseReport();
		r.gpg.path = null;
		expect(diagnose(r).some((f) => f.id === "gpg-missing")).toBe(true);
	});

	it("flags pinentry-curses-only — the exact footgun on the dev machine", () => {
		const r = baseReport();
		r.pinentry.found = { "pinentry-curses": "/opt/homebrew/bin/pinentry-curses" };
		const finding = diagnose(r).find((f) => f.id === "pinentry-tty-only");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warning");
	});

	it("does not flag pinentry-tty-only when a GUI pinentry is present", () => {
		const r = baseReport();
		r.pinentry.found = {
			"pinentry-mac": "/opt/homebrew/bin/pinentry-mac",
			"pinentry-curses": "/opt/homebrew/bin/pinentry-curses",
		};
		expect(diagnose(r).some((f) => f.id === "pinentry-tty-only")).toBe(false);
	});

	it("flags pinentry-program pointing at missing binary", () => {
		const r = baseReport();
		r.agentConf.exists = true;
		r.agentConf.pinentryProgram = "/does/not/exist/pinentry";
		r.pinentry.found = { "pinentry-mac": "/opt/homebrew/bin/pinentry-mac" };
		expect(diagnose(r).some((f) => f.id === "pinentry-missing")).toBe(true);
	});

	it("notes when commit.gpgsign is enabled globally", () => {
		const r = baseReport();
		r.git.effective.commitGpgsign = true;
		r.git.willAutoSignCommits = true;
		r.git.effective.signingKey = "ABCDEF0123456789";
		const found = diagnose(r);
		expect(found.some((f) => f.id === "commit-gpgsign-on")).toBe(true);
		expect(found.some((f) => f.id === "signing-no-key")).toBe(false);
	});

	it("warns when signing is enabled but no key is set", () => {
		const r = baseReport();
		r.git.effective.commitGpgsign = true;
		r.git.willAutoSignCommits = true;
		expect(diagnose(r).some((f) => f.id === "signing-no-key")).toBe(true);
	});

	it("reports all-clear on a healthy environment", () => {
		const r = baseReport();
		r.pinentry.found = { "pinentry-mac": "/opt/homebrew/bin/pinentry-mac" };
		expect(diagnose(r)).toEqual([{ id: "all-clear", severity: "ok", title: "Environment looks healthy." }]);
	});
});

// ---------------------------------------------------------------------------
// runDoctor (integration of the pure bits, using a mock exec)
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
	it("produces a coherent report with a scripted exec + in-memory conf", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "which") {
				const target = args[0];
				if (target === "gpg") return { stdout: "/opt/homebrew/bin/gpg\n", stderr: "", code: 0 };
				if (target === "pinentry-curses")
					return { stdout: "/opt/homebrew/bin/pinentry-curses\n", stderr: "", code: 0 };
				if (target === "pinentry-tty") return { stdout: "/opt/homebrew/bin/pinentry-tty\n", stderr: "", code: 0 };
				return { stdout: "", stderr: "", code: 1 };
			}
			if (cmd === "gpg" && args[0] === "--version") {
				return { stdout: "gpg (GnuPG) 2.4.5\nlibgcrypt 1.10.3\n", stderr: "", code: 0 };
			}
			if (cmd === "gpg" && args[0] === "--list-secret-keys") {
				return { stdout: "", stderr: "", code: 0 };
			}
			if (cmd === "git") {
				// All git config lookups miss in this fixture.
				return { stdout: "", stderr: "", code: 1 };
			}
			return { stdout: "", stderr: "", code: 127 };
		};

		const report = await runDoctor(exec, {
			cwd: "/tmp/test",
			gpgAgentConfPath: "/nonexistent/gpg-agent.conf",
			readFile: async () => {
				throw new Error("ENOENT");
			},
		});

		expect(report.gpg.path).toBe("/opt/homebrew/bin/gpg");
		expect(report.gpg.version).toBe("2.4.5");
		expect(report.pinentry.found).toHaveProperty("pinentry-curses");
		expect(report.pinentry.found).not.toHaveProperty("pinentry-mac");
		expect(report.agentConf.exists).toBe(false);
		expect(report.findings.some((f) => f.id === "pinentry-tty-only")).toBe(true);

		// Rendering smoke-test: no crashes, non-empty output.
		const text = renderReport(report);
		expect(text).toContain("pi-gpg doctor");
		expect(text).toContain("pinentry");
	});

	it("parses default-cache-ttl / max-cache-ttl from gpg-agent.conf", async () => {
		const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
		const report = await runDoctor(exec, {
			cwd: "/tmp/test",
			gpgAgentConfPath: "/fake/gpg-agent.conf",
			readFile: async () =>
				["# comment", "default-cache-ttl 600", "max-cache-ttl 7200", "pinentry-program /x"].join("\n"),
		});

		expect(report.agentConf.exists).toBe(true);
		expect(report.agentConf.defaultCacheTtl).toBe(600);
		expect(report.agentConf.maxCacheTtl).toBe(7200);
		expect(report.agentConf.pinentryProgram).toBe("/x");
	});
});

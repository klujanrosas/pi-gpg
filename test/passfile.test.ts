import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PassfileRegistry } from "../src/passfile.js";

describe("PassfileRegistry", () => {
	it("allocates a 0600 file with the passphrase + trailing newline", async () => {
		const reg = new PassfileRegistry();
		const handle = await reg.allocate(Buffer.from("hunter2"));
		try {
			const contents = await readFile(handle.path, "utf8");
			expect(contents).toBe("hunter2\n");
			const s = await stat(handle.path);
			// File mode 0600: owner rw, nobody else.
			expect(s.mode & 0o777).toBe(0o600);
			// Directory mode 0700.
			const dir = handle.path.slice(0, handle.path.lastIndexOf("/"));
			const ds = await stat(dir);
			expect(ds.mode & 0o777).toBe(0o700);
		} finally {
			await handle.cleanup();
		}
	});

	it("cleanup removes the containing directory", async () => {
		const reg = new PassfileRegistry();
		const handle = await reg.allocate(Buffer.from("x"));
		await handle.cleanup();
		await expect(stat(handle.path)).rejects.toThrow();
		expect(reg.liveCount).toBe(0);
	});

	it("sweep removes all outstanding entries", async () => {
		const reg = new PassfileRegistry();
		const a = await reg.allocate(Buffer.from("a"));
		const b = await reg.allocate(Buffer.from("b"));
		expect(reg.liveCount).toBe(2);
		await reg.sweep();
		expect(reg.liveCount).toBe(0);
		await expect(stat(a.path)).rejects.toThrow();
		await expect(stat(b.path)).rejects.toThrow();
	});

	it("tolerates double-cleanup without throwing", async () => {
		const reg = new PassfileRegistry();
		const handle = await reg.allocate(Buffer.from("x"));
		await handle.cleanup();
		await expect(handle.cleanup()).resolves.toBeUndefined();
	});
});

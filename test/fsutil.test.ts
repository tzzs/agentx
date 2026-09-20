import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../src/fsutil.js";

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "agentx-fsutil-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("atomicWriteFile creates the parent directories it needs", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = join(dir, "nested", "deeper", "state.json");
    await atomicWriteFile(file, '{"ok":true}');
    assert.equal(await readFile(file, "utf8"), '{"ok":true}');
  } finally { await cleanup(); }
});

test("atomicWriteFile replaces existing contents and leaves no temp files behind", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = join(dir, "state.json");
    await atomicWriteFile(file, "first");
    await atomicWriteFile(file, "second");
    assert.equal(await readFile(file, "utf8"), "second");
    assert.deepEqual(await readdir(dir), ["state.json"]);
  } finally { await cleanup(); }
});

test("atomicWriteFile writes state files owner-only, wherever they live", {
  // Windows has no POSIX permission bits, so the mode it reports proves nothing there.
  skip: process.platform === "win32" && "file modes are not enforced on Windows",
}, async () => {
  const { dir, cleanup } = await tempDir();
  try {
    // Runtime state can carry a provider API key, so a group- or world-readable
    // copy of it is a leak even on a single-user machine.
    await writeFile(join(dir, "seed.txt"), "");
    const file = join(dir, "seed.txt");
    await atomicWriteFile(file, "secret");
    const info = await stat(file);
    assert.equal(info.mode & 0o077, 0, `state file is group/world readable: ${(info.mode & 0o777).toString(8)}`);
  } finally { await cleanup(); }
});

test("concurrent atomicWriteFile calls all land without racing each other's temp file", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = join(dir, "shared.json");
    await Promise.all(Array.from({ length: 8 }, (_, index) => atomicWriteFile(file, String(index))));
    assert.match(await readFile(file, "utf8"), /^[0-7]$/);
    assert.deepEqual(await readdir(dir), ["shared.json"]);
  } finally { await cleanup(); }
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { shellProfilePath, shellSingleQuote, parseCredentialExports, readCredentialExports, upsertCredentialExport, writeCredentialExport } from "../src/shell-profile.js";

/** POSIX mode bits don't exist on Windows (writeFile ignores mode, stat reports 0666), so mode assertions are scoped. */
const posix = process.platform !== "win32";

test("shellProfilePath: zsh honors ZDOTDIR, bash picks the platform login profile, other shells are refused", () => {
  assert.equal(shellProfilePath({ SHELL: "/bin/zsh", HOME: "/home/u" }, "darwin"), join("/home/u", ".zshrc"));
  assert.equal(shellProfilePath({ SHELL: "/bin/zsh", HOME: "/home/u", ZDOTDIR: "/home/u/zdot" }, "darwin"), join("/home/u/zdot", ".zshrc"));
  assert.equal(shellProfilePath({ SHELL: "/bin/bash", HOME: "/home/u" }, "darwin"), join("/home/u", ".bash_profile"));
  assert.equal(shellProfilePath({ SHELL: "/bin/bash", HOME: "/home/u" }, "linux"), join("/home/u", ".bashrc"));
  assert.equal(shellProfilePath({ SHELL: "/usr/bin/fish", HOME: "/home/u" }, "linux"), undefined);
  assert.equal(shellProfilePath({ HOME: "/home/u" }, "linux"), undefined);
});

test("upsertCredentialExport appends a marked block and replaces it in place", () => {
  const first = upsertCredentialExport("# my profile\nalias ll='ls -l'\n", "AGENTX_DS_API_KEY", "sk-one");
  assert.equal(first.changed, true);
  assert.equal(first.replaced, false);
  assert.ok(first.content.startsWith("# my profile\nalias ll='ls -l'\n"));
  assert.match(first.content, /# >>> agentx credentials: AGENTX_DS_API_KEY >>>\nexport AGENTX_DS_API_KEY='sk-one'\n# <<< agentx credentials: AGENTX_DS_API_KEY <<<\n$/);

  const second = upsertCredentialExport(first.content, "AGENTX_DS_API_KEY", "sk-two");
  assert.equal(second.changed, true);
  assert.equal(second.replaced, true);
  assert.equal((second.content.match(/# >>> agentx credentials/g) ?? []).length, 1);
  assert.match(second.content, /export AGENTX_DS_API_KEY='sk-two'/);
  assert.ok(second.content.startsWith("# my profile\nalias ll='ls -l'\n"));
  assert.ok(second.content.endsWith("# <<< agentx credentials: AGENTX_DS_API_KEY <<<\n"));

  const same = upsertCredentialExport(second.content, "AGENTX_DS_API_KEY", "sk-two");
  assert.equal(same.changed, false);
});

test("upsertCredentialExport leaves other providers' blocks untouched and quotes shell metacharacters", () => {
  const a = upsertCredentialExport("", "AGENTX_A_API_KEY", "sk-a");
  const b = upsertCredentialExport(a.content, "AGENTX_B_API_KEY", "a b$`'c");
  assert.match(b.content, /export AGENTX_A_API_KEY='sk-a'/);
  assert.ok(b.content.includes("export AGENTX_B_API_KEY=" + shellSingleQuote("a b$`'c")));
  assert.equal(shellSingleQuote("a b$`'c"), "'a b$`'\\''c'");
});

test("writeCredentialExport creates with 0600, backs up an existing profile, and reports no-op rewrites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentx-profile-"));
  try {
    const file = join(dir, ".zshrc");
    const created = await writeCredentialExport(file, "AGENTX_X_API_KEY", "sk-1");
    assert.equal(created.changed, true);
    assert.equal(created.backup, undefined);
    if (posix) {
      assert.equal(created.mode, 0o600);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    } else {
      assert.equal(created.mode, undefined, "Windows has no POSIX modes to report");
    }

    const updated = await writeCredentialExport(file, "AGENTX_X_API_KEY", "sk-2");
    assert.equal(updated.changed, true);
    assert.equal(updated.replaced, true);
    assert.equal(updated.backup, `${file}.agentx.bak`);
    assert.match(await readFile(updated.backup!, "utf8"), /sk-1/);

    const noop = await writeCredentialExport(file, "AGENTX_X_API_KEY", "sk-2");
    assert.equal(noop.changed, false);
    assert.match(await readFile(file, "utf8"), /sk-2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeCredentialExport leaves an existing profile's permissions alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentx-profile-mode-"));
  try {
    const file = join(dir, ".bashrc");
    await writeFile(file, "alias x=y\n", { mode: 0o644 });
    const before = (await stat(file)).mode & 0o777;
    const result = await writeCredentialExport(file, "AGENTX_Y_API_KEY", "sk");
    if (posix) {
      assert.equal(result.mode, before);
      assert.equal((await stat(file)).mode & 0o777, before);
    }
    assert.match(await readFile(file, "utf8"), /export AGENTX_Y_API_KEY='sk'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseCredentialExports round-trips written blocks, including quoted metacharacters", () => {
  const first = upsertCredentialExport("", "AGENTX_A_API_KEY", "sk-a'b");
  const both = upsertCredentialExport(first.content, "AGENTX_B_API_KEY", "sk-b$`");
  assert.deepEqual([...parseCredentialExports(both.content)], [["AGENTX_A_API_KEY", "sk-a'b"], ["AGENTX_B_API_KEY", "sk-b$`"]]);
});

test("parseCredentialExports ignores hand-edited or mismatched blocks instead of guessing", () => {
  const tampered = [
    "# >>> agentx credentials: AGENTX_A_API_KEY >>>",
    "export AGENTX_A_API_KEY='sk-a'",
    "# <<< agentx credentials: AGENTX_B_API_KEY <<<",
    "# >>> agentx credentials: AGENTX_C_API_KEY >>>",
    "export AGENTX_C_API_KEY=sk-c",
    "# <<< agentx credentials: AGENTX_C_API_KEY <<<",
  ].join("\n");
  assert.equal(parseCredentialExports(tampered).size, 0);
});

test("readCredentialExports reads a written profile and tolerates a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentx-profile-read-"));
  try {
    const file = join(dir, ".zshrc");
    await writeCredentialExport(file, "AGENTX_Z_API_KEY", "sk-z");
    assert.equal((await readCredentialExports(file)).get("AGENTX_Z_API_KEY"), "sk-z");
    assert.equal((await readCredentialExports(join(dir, "does-not-exist"))).size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

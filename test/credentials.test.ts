import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { credentialEnvName, providerById } from "../src/providers/registry.js";
import { credentialInstructions, credentialSource, hydrateProfileCredentials, resetProfileCredentials, resolveCredential, storedCredential } from "../src/credentials.js";
import { writeCredentialExport } from "../src/shell-profile.js";

const opencode = providerById("opencode");

test.afterEach(() => resetProfileCredentials());

test("prefers the agentx-prefixed variable over the legacy one", () => {
  process.env.AGENTX_OPENCODE_API_KEY = "prefixed";
  process.env.OPENCODE_API_KEY = "legacy";
  assert.equal(storedCredential(opencode), "prefixed");
  delete process.env.AGENTX_OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
});

test("uses an existing legacy key directly when no prefixed variable is set", async () => {
  process.env.OPENCODE_API_KEY = "legacy";
  assert.equal(storedCredential(opencode), "legacy");
  assert.equal(await resolveCredential(opencode), "legacy");
  delete process.env.OPENCODE_API_KEY;
});

test("derives the prefixed name from the provider definition", () => {
  assert.equal(credentialEnvName(providerById("opencode")), "AGENTX_OPENCODE_API_KEY");
  assert.equal(credentialEnvName(providerById("deepseek")), "AGENTX_DEEPSEEK_API_KEY");
  assert.equal(credentialEnvName(providerById("openrouter")), "AGENTX_OPENROUTER_API_KEY");
});

test("reports which source provided the credential", () => {
  delete process.env.AGENTX_OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  assert.equal(credentialSource(opencode), undefined);
  process.env.AGENTX_OPENCODE_API_KEY = "p";
  assert.equal(credentialSource(opencode), "AGENTX_OPENCODE_API_KEY");
  delete process.env.AGENTX_OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "l";
  assert.equal(credentialSource(opencode), "OPENCODE_API_KEY");
  delete process.env.OPENCODE_API_KEY;
});

test("explicit overrides win over environment variables", async () => {
  process.env.AGENTX_OPENCODE_API_KEY = "prefixed";
  assert.equal(await resolveCredential(opencode, "override"), "override");
  delete process.env.AGENTX_OPENCODE_API_KEY;
});

test("auth login instructions mention the prefixed variable and legacy fallback", () => {
  const text = credentialInstructions(opencode);
  assert.match(text, /export AGENTX_OPENCODE_API_KEY=/);
  assert.match(text, /OPENCODE_API_KEY is also picked up/);
});

test("loads credentials from the shell profile without merging them into the process environment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentx-cred-profile-"));
  try {
    const file = join(dir, ".zshrc");
    await writeCredentialExport(file, "AGENTX_OPENCODE_API_KEY", "from-profile");
    delete process.env.AGENTX_OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    await hydrateProfileCredentials({ SHELL: "/bin/zsh", HOME: dir }, "linux");

    assert.equal(storedCredential(opencode), "from-profile");
    assert.equal(await resolveCredential(opencode), "from-profile");
    assert.equal(credentialSource(opencode), `AGENTX_OPENCODE_API_KEY (from ${file})`);
    // The key must stay out of process.env: clientEnvironment inherits it.
    assert.equal(process.env.AGENTX_OPENCODE_API_KEY, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("environment variables win over shell-profile credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentx-cred-profile-env-"));
  try {
    await writeCredentialExport(join(dir, ".zshrc"), "AGENTX_OPENCODE_API_KEY", "from-profile");
    await hydrateProfileCredentials({ SHELL: "/bin/zsh", HOME: dir }, "linux");
    process.env.OPENCODE_API_KEY = "from-env";
    assert.equal(storedCredential(opencode), "from-env");
    assert.equal(credentialSource(opencode), "OPENCODE_API_KEY");
    delete process.env.OPENCODE_API_KEY;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hydrating with a shell AgentX cannot write clears previously loaded profile credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentx-cred-profile-clear-"));
  try {
    await writeCredentialExport(join(dir, ".zshrc"), "AGENTX_OPENCODE_API_KEY", "from-profile");
    await hydrateProfileCredentials({ SHELL: "/bin/zsh", HOME: dir }, "linux");
    assert.equal(storedCredential(opencode), "from-profile");
    await hydrateProfileCredentials({ SHELL: "/usr/bin/fish", HOME: dir }, "linux");
    assert.equal(storedCredential(opencode), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

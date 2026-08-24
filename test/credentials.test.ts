import test from "node:test";
import assert from "node:assert/strict";
import { credentialEnvName, providerById } from "../src/providers/registry.js";
import { credentialInstructions, credentialSource, resolveCredential, storedCredential } from "../src/credentials.js";

const opencode = providerById("opencode");

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

import test from "node:test";
import assert from "node:assert/strict";
import { providerById } from "../src/providers/registry.js";
import { credentialSource, storedCredential } from "../src/credentials.js";
import { profileFile } from "../src/profiles.js";

test("provider credentials use provider-specific environment variables", () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  assert.equal(storedCredential(providerById("deepseek")), "test-key");
  delete process.env.DEEPSEEK_API_KEY;
});

test("agentx-prefixed credentials take precedence over legacy variables", () => {
  process.env.AGENTX_DEEPSEEK_API_KEY = "prefixed-key";
  assert.equal(storedCredential(providerById("deepseek")), "prefixed-key");
  assert.equal(credentialSource(providerById("deepseek")), "AGENTX_DEEPSEEK_API_KEY");
  delete process.env.AGENTX_DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "legacy-key";
  assert.equal(credentialSource(providerById("deepseek")), "DEEPSEEK_API_KEY");
  delete process.env.DEEPSEEK_API_KEY;
});
test("profiles are stored outside the project", () => { assert.match(profileFile(), /agentx[\\/]profiles\.json$/); });

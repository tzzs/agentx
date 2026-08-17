import test from "node:test";
import assert from "node:assert/strict";
import { providerById } from "../src/providers/registry.js";
import { storedCredential } from "../src/credentials.js";
import { profileFile } from "../src/profiles.js";

test("provider credentials use provider-specific environment variables", async () => {
  process.env.DEEPSEEK_API_KEY = "test-key";
  assert.equal(await storedCredential(providerById("deepseek")), "test-key");
  delete process.env.DEEPSEEK_API_KEY;
});
test("profiles are stored outside the project", () => { assert.match(profileFile(), /agentx[\\/]profiles\.json$/); });

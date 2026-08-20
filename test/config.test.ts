import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("falls back to the last used model when none is specified", () => {
  const config = loadConfig({});
  assert.equal(config.model, "deepseek-v4-flash");
});
test("remembers the last used model only for the matching provider", () => {
  const config = loadConfig({ provider: "openrouter" });
  assert.equal(config.model, "openai/gpt-4o-mini");
});
test("explicit --model takes precedence over the remembered model", () => {
  const config = loadConfig({ model: "gpt-5.6-luna" });
  assert.equal(config.model, "gpt-5.6-luna");
});
test("AGENTX_MODEL takes precedence over the remembered model", () => {
  process.env.AGENTX_MODEL = "deepseek-v4-pro";
  try { assert.equal(loadConfig({}).model, "deepseek-v4-pro"); }
  finally { delete process.env.AGENTX_MODEL; }
});

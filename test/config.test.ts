import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseCliOptions } from "../src/config.js";
import { defaultModelFor } from "../src/selection.js";
import { loadLastSelection, saveLastModel } from "../src/runtime.js";

let configDir: string;

test.before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-config-test-"));
  process.env.XDG_CONFIG_HOME = configDir;
  // Isolate these tests from AGENTX_* set by the outer shell.
  delete process.env.AGENTX_PROVIDER;
  delete process.env.AGENTX_MODEL;
});

test.after(async () => { delete process.env.XDG_CONFIG_HOME; await rm(configDir, { recursive: true, force: true }); });

test("falls back to the default model when nothing was remembered", () => {
  assert.equal(loadConfig({}, {}).model, "gpt-5.6-luna");
});

test("remembers the last provider and model when no model is specified", async () => {
  await saveLastModel("opencode", "deepseek-v4-flash");
  const remembered = await loadLastSelection();
  assert.equal(loadConfig({}, remembered).model, "deepseek-v4-flash");
});

test("remembers the last model only for the matching provider", async () => {
  await saveLastModel("opencode", "deepseek-v4-flash");
  const remembered = await loadLastSelection();
  assert.equal(loadConfig({ provider: "openrouter" }, remembered).model, defaultModelFor("openrouter"));
});

test("explicit --model takes precedence over the remembered model", async () => {
  await saveLastModel("opencode", "deepseek-v4-flash");
  const remembered = await loadLastSelection();
  assert.equal(loadConfig({ model: "gpt-5.6-luna" }, remembered).model, "gpt-5.6-luna");
});

test("default model comes from the registry as the single source", () => {
  assert.equal(loadConfig({ provider: "openrouter" }, {}).model, defaultModelFor("openrouter"));
  assert.equal(loadConfig({ provider: "deepseek" }, {}).model, defaultModelFor("deepseek"));
});

test("AGENTX_MODEL takes precedence over the remembered model", async () => {
  await saveLastModel("opencode", "deepseek-v4-flash");
  const remembered = await loadLastSelection();
  process.env.AGENTX_MODEL = "deepseek-v4-pro";
  try { assert.equal(loadConfig({}, remembered).model, "deepseek-v4-pro"); }
  finally { delete process.env.AGENTX_MODEL; }
});

test("deprecated auto falls back to a concrete model", () => {
  process.env.AGENTX_MODEL = "auto";
  try { assert.equal(loadConfig({}).model, defaultModelFor("opencode")); }
  finally { delete process.env.AGENTX_MODEL; }
  assert.equal(loadConfig({ model: "auto" }).model, defaultModelFor("opencode"));
});

test("parseCliOptions pairs flags with values", () => {
  assert.deepEqual(parseCliOptions(["--model", "gpt-x", "--port", "9000"]), { model: "gpt-x", port: "9000" });
});
test("parseCliOptions keeps a boolean flag in front of another flag", () => {
  assert.deepEqual(parseCliOptions(["--verbose", "--model", "gpt-x"]), { verbose: "true", model: "gpt-x" });
});
test("parseCliOptions supports --key=value and trailing flags", () => {
  assert.deepEqual(parseCliOptions(["--model=gpt-x", "--verbose"]), { model: "gpt-x", verbose: "true" });
});
test("--verbose enables debug logging", () => {
  delete process.env.AGENTX_LOG_LEVEL;
  assert.equal(loadConfig({ verbose: "true" }).logLevel, "debug");
  assert.equal(loadConfig({}).logLevel, "info");
});

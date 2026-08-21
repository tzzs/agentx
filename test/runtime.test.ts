import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDefaultRuntime, loadLastModel, runtimeFile, saveDefaultRuntime, saveLastModel } from "../src/runtime.js";

let dir: string;

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentx-runtime-"));
  process.env.XDG_CONFIG_HOME = dir;
});

test.after(async () => {
  delete process.env.XDG_CONFIG_HOME;
  await rm(dir, { recursive: true, force: true });
});

test("runtime.json is stored under the agentx config directory", () => {
  assert.equal(runtimeFile(), join(dir, "agentx", "runtime.json"));
});

test("default runtime persists per client", async () => {
  await saveDefaultRuntime("claude", { provider: "deepseek", model: "deepseek-v4-pro" });
  await saveDefaultRuntime("codex", { provider: "openrouter", model: "anthropic/claude-sonnet-4" });
  assert.deepEqual(await loadDefaultRuntime("claude"), { provider: "deepseek", model: "deepseek-v4-pro" });
  assert.deepEqual(await loadDefaultRuntime("codex"), { provider: "openrouter", model: "anthropic/claude-sonnet-4" });
  // Per-client defaults are independent.
  assert.notDeepEqual(await loadDefaultRuntime("claude"), await loadDefaultRuntime("codex"));
});

test("overwriting a default replaces it instead of accumulating", async () => {
  await saveDefaultRuntime("pi", { provider: "opencode", model: "gpt-5.6-luna" });
  await saveDefaultRuntime("pi", { provider: "deepseek", model: "deepseek-v4-flash" });
  assert.deepEqual(await loadDefaultRuntime("pi"), { provider: "deepseek", model: "deepseek-v4-flash" });
});

test("last model persists per provider", async () => {
  await saveLastModel("opencode", "gpt-5.6-luna");
  await saveLastModel("deepseek", "deepseek-v4-pro");
  assert.equal(await loadLastModel("opencode"), "gpt-5.6-luna");
  assert.equal(await loadLastModel("deepseek"), "deepseek-v4-pro");
});

test("returns nothing for absent defaults and last models", async () => {
  assert.equal(await loadDefaultRuntime("nonexistent"), undefined);
  assert.equal(await loadLastModel("nonexistent"), undefined);
});

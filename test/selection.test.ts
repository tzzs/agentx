import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultModelFor, modelAvailable, providerAcceptsCustomModels, resolveModelForProvider, resolveRuntimeNonInteractive } from "../src/selection.js";
import { runtimeFile, saveDefaultRuntime, saveLastModel } from "../src/runtime.js";

let dir: string;

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentx-selection-"));
  process.env.XDG_CONFIG_HOME = dir;
});

// Each test starts from a clean runtime state so saves never leak.
test.beforeEach(async () => {
  await rm(runtimeFile(), { force: true });
  delete process.env.AGENTX_PROVIDER;
  delete process.env.AGENTX_MODEL;
});

test.after(async () => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.AGENTX_PROVIDER;
  delete process.env.AGENTX_MODEL;
  await rm(dir, { recursive: true, force: true });
});

test("model availability respects the provider namespace", () => {
  assert.equal(modelAvailable("deepseek", "deepseek-v4-flash"), true);
  assert.equal(modelAvailable("deepseek", "gpt-5.6-luna"), false);
  assert.equal(modelAvailable("opencode", "gpt-5.6-luna"), true);
  assert.equal(modelAvailable("openrouter", "anthropic/claude-sonnet-4"), true);
  assert.equal(modelAvailable("openrouter", "auto"), true);
});

test("auto is always available", () => {
  assert.equal(modelAvailable("deepseek", "auto"), true);
  assert.equal(modelAvailable("opencode", "auto"), true);
});

test("only openrouter accepts custom model ids", () => {
  assert.equal(providerAcceptsCustomModels("openrouter"), true);
  assert.equal(providerAcceptsCustomModels("deepseek"), false);
  assert.equal(providerAcceptsCustomModels("opencode"), false);
});

test("default model is the provider's first model", () => {
  assert.equal(defaultModelFor("deepseek"), "deepseek-v4-pro");
  assert.equal(defaultModelFor("opencode"), "gpt-5.6-luna");
});

test("resolves the remembered last model for a provider", async () => {
  await saveLastModel("deepseek", "deepseek-v4-flash");
  assert.equal(await resolveModelForProvider("deepseek"), "deepseek-v4-flash");
});

test("falls back to the provider default when no last model matches", async () => {
  await saveLastModel("opencode", "gpt-5.6-luna");
  // DeepSeek has no last model saved; a model owned by OpenCode must not carry over.
  assert.equal(await resolveModelForProvider("deepseek"), "deepseek-v4-pro");
});

test("keeps a preferred model when it belongs to the provider", async () => {
  assert.equal(await resolveModelForProvider("deepseek", "deepseek-v4-pro"), "deepseek-v4-pro");
});

test("auto model preference is preserved through resolution", async () => {
  await saveLastModel("deepseek", "deepseek-v4-pro");
  assert.equal(await resolveModelForProvider("deepseek", "auto"), "auto");
});

test("provider switch to an unavailable model re-selects automatically", async () => {
  await saveLastModel("opencode", "gpt-5.6-luna");
  // gpt-5.6-luna cannot be used on DeepSeek, so it must re-select.
  assert.equal(await resolveModelForProvider("deepseek"), "deepseek-v4-pro");
});

test("provider switch keeps a still-available model", async () => {
  // deepseek-v4-flash exists on both OpenCode and DeepSeek, so it is retained.
  assert.equal(await resolveModelForProvider("deepseek", "deepseek-v4-flash"), "deepseek-v4-flash");
});

test("CLI --provider / --model take precedence", async () => {
  const decision = await resolveRuntimeNonInteractive("claude", { provider: "deepseek", model: "deepseek-v4-flash" });
  assert.equal(decision.provider, "deepseek");
  assert.equal(decision.model, "deepseek-v4-flash");
  assert.equal(decision.source, "cli");
  assert.equal(decision.defaultApplied, false);
});

test("CLI --model alone infers the provider", async () => {
  const decision = await resolveRuntimeNonInteractive("claude", { model: "gpt-5.6-luna" });
  assert.equal(decision.provider, "opencode");
  assert.equal(decision.model, "gpt-5.6-luna");
  assert.equal(decision.source, "cli");
});

test("environment variables are used when no CLI flags are given", async () => {
  process.env.AGENTX_PROVIDER = "deepseek";
  const decision = await resolveRuntimeNonInteractive("claude", {});
  assert.equal(decision.provider, "deepseek");
  assert.equal(decision.source, "env");
  delete process.env.AGENTX_PROVIDER;
});

test("saved default is used when nothing overrides it", async () => {
  await saveDefaultRuntime("claude", { provider: "deepseek", model: "deepseek-v4-pro" });
  const decision = await resolveRuntimeNonInteractive("claude", {});
  assert.equal(decision.provider, "deepseek");
  assert.equal(decision.model, "deepseek-v4-pro");
  assert.equal(decision.source, "default");
  assert.equal(decision.defaultApplied, true);
});

test("different clients resolve different saved defaults", async () => {
  await saveDefaultRuntime("claude", { provider: "deepseek", model: "deepseek-v4-pro" });
  await saveDefaultRuntime("codex", { provider: "openrouter", model: "anthropic/claude-sonnet-4" });
  assert.equal((await resolveRuntimeNonInteractive("claude", {})).provider, "deepseek");
  assert.equal((await resolveRuntimeNonInteractive("codex", {})).provider, "openrouter");
});

test("built-in default is used when nothing is configured", async () => {
  const decision = await resolveRuntimeNonInteractive("claude", {});
  assert.equal(decision.provider, "opencode");
  assert.equal(decision.model, "gpt-5.6-luna");
  assert.equal(decision.source, "builtin");
});

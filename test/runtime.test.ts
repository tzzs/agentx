import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetCustomProvider, forgetRuntime, loadCustomProviders, loadDefaultRuntime, loadLastModel, loadLastQuickAction, loadOpenCodeModels, loadOpenRouterModels, remembererProviders, rememberedModelIds, runtimeFile, saveCustomProvider, saveDefaultRuntime, saveLastModel, saveLastQuickAction, saveOpenCodeModels, saveOpenRouterModels,
} from "../src/runtime.js";

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

test("last quick-start action persists per client and is independent across clients", async () => {
  await saveLastQuickAction("claude", "native");
  await saveLastQuickAction("codex", "start");
  assert.equal(await loadLastQuickAction("claude"), "native");
  assert.equal(await loadLastQuickAction("codex"), "start");
  assert.equal(await loadLastQuickAction("nonexistent"), undefined);
  // Overwriting replaces instead of accumulating.
  await saveLastQuickAction("claude", "start");
  assert.equal(await loadLastQuickAction("claude"), "start");
});

test("persists and reloads the OpenRouter catalog id cache", async () => {
  await saveOpenRouterModels(["vendor/alpha", "vendor/beta"]);
  assert.deepEqual(await loadOpenRouterModels(), ["vendor/alpha", "vendor/beta"]);
  assert.deepEqual(JSON.parse(await readFile(runtimeFile(), "utf8")).openrouterModels, ["vendor/alpha", "vendor/beta"]);
  // Round-trips through the real runtime state file.
  await saveOpenRouterModels(["vendor/gamma"]);
  assert.deepEqual(await loadOpenRouterModels(), ["vendor/gamma"]);
  await saveOpenRouterModels(["vendor/alpha", "vendor/beta"]);
});

test("saveOpenRouterModels skips the write when the id list is unchanged", async () => {
  await saveOpenRouterModels(["vendor/delta", "vendor/epsilon"]);
  const before = (await stat(runtimeFile())).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await saveOpenRouterModels(["vendor/delta", "vendor/epsilon"]);
  assert.equal((await stat(runtimeFile())).mtimeMs, before, "identical content must not rewrite the file");
  await saveOpenRouterModels(["vendor/zeta"]);
  assert.notEqual((await stat(runtimeFile())).mtimeMs, before, "a changed list must still write");
});

test("persists and reloads the OpenCode catalog id cache with its fetch timestamp", async () => {
  const first = { ids: ["gpt-5.6-luna", "kimi-k3"], fetchedAt: 1_700_000_000_000 };
  await saveOpenCodeModels(first);
  assert.deepEqual(await loadOpenCodeModels(), first);
  assert.deepEqual(JSON.parse(await readFile(runtimeFile(), "utf8")).opencodeModels, first);
  // Round-trips through the real runtime state file, and a later save replaces the whole snapshot.
  const second = { ids: ["glm-5.2"], fetchedAt: 1_800_000_000_000 };
  await saveOpenCodeModels(second);
  assert.deepEqual(await loadOpenCodeModels(), second);
});

test("loadOpenCodeModels returns undefined before any snapshot has been saved", async () => {
  const dedicated = await mkdtemp(join(tmpdir(), "agentx-runtime-opencode-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dedicated;
  try {
    assert.equal(await loadOpenCodeModels(), undefined);
  } finally {
    process.env.XDG_CONFIG_HOME = previous;
    await rm(dedicated, { recursive: true, force: true });
  }
});

test("forgetRuntime scrubs a renamed model id from defaults, last models, and last selection", async () => {
  await saveDefaultRuntime("claude", { provider: "openrouter", model: "vendor/renamed" });
  await saveDefaultRuntime("codex", { provider: "openrouter", model: "vendor/renamed" });
  await saveDefaultRuntime("pi", { provider: "openrouter", model: "vendor/kept" });
  await saveLastModel("openrouter", "vendor/renamed");

  assert.equal(await forgetRuntime({ provider: "openrouter", model: "vendor/renamed" }), true);
  assert.equal(await loadDefaultRuntime("claude"), undefined);
  assert.equal(await loadDefaultRuntime("codex"), undefined);
  assert.equal((await loadDefaultRuntime("pi"))?.model, "vendor/kept");
  assert.equal(await loadLastModel("openrouter"), undefined);
  // The remembered ids for openrouter no longer include the scrubbed id.
  assert.ok(!(await rememberedModelIds("openrouter")).includes("vendor/renamed"));

  // Forgetting an id that was never saved reports no damage.
  assert.equal(await forgetRuntime({ provider: "openrouter", model: "vendor/ghost" }), false);

  // Restore so other tests see a clean provider memory.
  await saveLastModel("openrouter", "vendor/kept");
});

test("forgetRuntime drops the last selection when it points at the scrubbed id", async () => {
  await saveDefaultRuntime("claude", { provider: "deepseek", model: "deepseek-v4-pro" });
  await saveLastModel("deepseek", "deepseek-v4-pro");
  assert.deepEqual(await rememberedModelIds("deepseek"), ["deepseek-v4-pro"]);

  assert.equal(await forgetRuntime({ provider: "deepseek", model: "deepseek-v4-pro" }), true);
  // The deepseek memory is gone; the state left by earlier tests stays intact.
  assert.ok(!(await remembererProviders()).some((entry) => entry.provider === "deepseek"));
  assert.equal(await forgetRuntime({ provider: "deepseek" }), false);
});

test("forgetRuntime clears an entire provider's memory when no model is given", async () => {
  await saveDefaultRuntime("claude", { provider: "openrouter", model: "vendor/alpha" });
  await saveDefaultRuntime("codex", { provider: "openrouter", model: "vendor/beta" });
  assert.ok(await forgetRuntime({ provider: "openrouter" }));
  // `last` and the openrouter last model fall too; other providers are untouched.
  assert.ok(!(await rememberedModelIds("openrouter")).includes("vendor/alpha"));
  assert.ok(!(await rememberedModelIds("openrouter")).includes("vendor/beta"));
});

test("saveCustomProvider/loadCustomProviders round-trip connection metadata only", async () => {
  await saveCustomProvider("my-llm", { name: "My LLM", baseUrl: "http://localhost:11434", protocol: "chat-completions" });
  await saveCustomProvider("other-llm", { name: "Other LLM", baseUrl: "http://localhost:8000", protocol: "anthropic", model: "custom" });
  const saved = await loadCustomProviders();
  assert.deepEqual(saved["my-llm"], { name: "My LLM", baseUrl: "http://localhost:11434", protocol: "chat-completions" });
  assert.deepEqual(saved["other-llm"], { name: "Other LLM", baseUrl: "http://localhost:8000", protocol: "anthropic", model: "custom" });
});

test("saving a custom provider a second time updates it in place rather than accumulating", async () => {
  await saveCustomProvider("updatable", { name: "Updatable", baseUrl: "http://a", protocol: "chat-completions" });
  await saveCustomProvider("updatable", { name: "Updatable", baseUrl: "http://b", protocol: "responses" });
  const saved = await loadCustomProviders();
  assert.equal(Object.keys(saved).length, 3); // my-llm, other-llm, updatable — no duplicate entries
  assert.deepEqual(saved["updatable"], { name: "Updatable", baseUrl: "http://b", protocol: "responses" });
});

test("runtime.json never contains anything that looks like an API key", async () => {
  const raw = await readFile(runtimeFile(), "utf8");
  assert.doesNotMatch(raw.toLowerCase(), /apikey|api_key|"key"\s*:/i);
});

test("forgetCustomProvider removes the persisted definition and any default/last-model memory pointing at it", async () => {
  await saveCustomProvider("temp-provider", { name: "Temp Provider", baseUrl: "http://x", protocol: "chat-completions" });
  await saveDefaultRuntime("claude", { provider: "temp-provider", model: "custom-model" });
  await saveLastModel("temp-provider", "custom-model");

  assert.equal(await forgetCustomProvider("temp-provider"), true);
  assert.equal((await loadCustomProviders())["temp-provider"], undefined);
  assert.equal(await loadDefaultRuntime("claude"), undefined);
  assert.equal(await loadLastModel("temp-provider"), undefined);

  // Forgetting an id that was never saved reports no damage.
  assert.equal(await forgetCustomProvider("never-existed"), false);
});

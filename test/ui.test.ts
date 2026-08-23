import test from "node:test";
import assert from "node:assert/strict";
import { providerEntries, runInteractiveLauncher } from "../src/ui.js";
import { defaultModelFor } from "../src/selection.js";

test("lists all configured providers from the registry", async () => {
  const entries = await providerEntries();
  assert.ok(entries.length >= 3);
  const ids = entries.map((entry) => entry.definition.id);
  assert.ok(ids.includes("opencode"));
  assert.ok(ids.includes("deepseek"));
  assert.ok(ids.includes("openrouter"));
});

test("reports configured status per provider", async () => {
  const entries = await providerEntries();
  const deepseek = entries.find((entry) => entry.definition.id === "deepseek");
  assert.ok(deepseek);
  assert.equal(deepseek.configured, Boolean(process.env.DEEPSEEK_API_KEY));
});

test("falls back to a deterministic default model in non-interactive mode", () => {
  const model = defaultModelFor("opencode");
  assert.equal(model, "gpt-5.6-luna");
});

test("launcher passes through unchanged in non-interactive mode", async () => {
  const initial = { provider: "deepseek", model: "deepseek-v4-pro", source: "default" as const, defaultApplied: true };
  const outcome = await runInteractiveLauncher("claude", initial);
  assert.equal(outcome.provider, "deepseek");
  assert.equal(outcome.model, "deepseek-v4-pro");
  assert.equal(outcome.defaultApplied, true);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.madeDefault, false);
});

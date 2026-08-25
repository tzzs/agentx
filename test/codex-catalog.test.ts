import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexCatalog, writeCodexCatalog, codexCatalogPath, catalogModels } from "../src/codex-catalog.js";
import type { ProviderModel } from "../src/providers/types.js";

test("catalog covers every registry model with the verified field set", () => {
  const catalog = JSON.parse(buildCodexCatalog()) as { models: Array<Record<string, unknown>> };
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash"));
  assert.ok(slugs.includes("gpt-5.6-luna"));
  for (const entry of catalog.models) {
    for (const key of ["slug", "display_name", "context_window", "supported_reasoning_levels", "visibility", "minimal_client_version", "model_messages"]) assert.ok(key in entry, `missing ${key}`);
    assert.equal(entry.visibility, "list");
  }
});

test("prefers real registry limits and falls back to safe defaults", () => {
  const models = [
    { provider: "opencode", model: "known-model", protocol: "chat-completions" as const, endpoint: "https://x", contextWindow: 1000000, maxOutputTokens: 384000, modalities: ["text", "image"] },
    { provider: "opencode", model: "unknown-model", protocol: "chat-completions" as const, endpoint: "https://x" },
  ];
  const catalog = JSON.parse(buildCodexCatalog(models)) as { models: any[] };
  const known = catalog.models.find((entry) => entry.slug === "known-model");
  const unknown = catalog.models.find((entry) => entry.slug === "unknown-model");
  assert.equal(known.context_window, 1000000);
  assert.equal(known.max_context_window, 1000000);
  assert.equal(known.max_output_tokens, 384000);
  assert.deepEqual(known.input_modalities, ["text", "image"]);
  assert.equal(unknown.context_window, 131072);
  assert.equal(unknown.max_output_tokens, 16384);
  assert.deepEqual(unknown.input_modalities, ["text"]);
});

test("writeCodexCatalog writes atomically and reports failures as undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentx-catalog-"));
  process.env.AGENTX_CODEX_CATALOG_FILE = join(dir, "nested", "codex-models.json");
  try {
    const written = await writeCodexCatalog();
    assert.ok(written?.endsWith("codex-models.json"));
    const parsed = JSON.parse(readFileSync(written!, "utf8")) as { models: unknown[] };
    assert.ok(Array.isArray(parsed.models) && parsed.models.length > 0);
    // An empty model list produces no file rather than an unusable catalog.
    assert.equal(await writeCodexCatalog([]), undefined);
  } finally {
    delete process.env.AGENTX_CODEX_CATALOG_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog path follows the agentx config directory convention", () => {
  delete process.env.AGENTX_CODEX_CATALOG_FILE;
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/xdg";
  try {
    assert.equal(codexCatalogPath(), join("/xdg", "agentx", "codex-models.json"));
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("catalogModels appends a custom OpenRouter id so Codex resolves its metadata", () => {
  const base: ProviderModel[] = [
    { provider: "openrouter", model: "openai/gpt-4o-mini", protocol: "chat-completions", endpoint: "https://x" },
  ];
  const models = catalogModels({ provider: "openrouter", model: "stealth/ox-alpha" }, base);
  assert.ok(models.some((model) => model.model === "stealth/ox-alpha"));
  const catalog = JSON.parse(buildCodexCatalog(models)) as { models: any[] };
  const custom = catalog.models.find((entry) => entry.slug === "stealth/ox-alpha");
  // Unknown id keeps conservative defaults instead of missing metadata.
  assert.equal(custom.context_window, 131072);
  assert.equal(custom.max_output_tokens, 16384);
});

test("catalogModels keeps the registry list for known, auto, and unknown providers", () => {
  const base: ProviderModel[] = [
    { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", endpoint: "https://x" },
  ];
  assert.equal(catalogModels({ provider: "deepseek", model: "deepseek-v4-pro" }, base), base);
  assert.equal(catalogModels({ provider: "deepseek", model: "auto" }, base), base);
  assert.equal(catalogModels({ provider: "nonexistent", model: "mystery" }, base), base);
});

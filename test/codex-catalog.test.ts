import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexCatalog, writeCodexCatalog, codexCatalogPath } from "../src/codex-catalog.js";

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

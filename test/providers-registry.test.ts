import test from "node:test";
import assert from "node:assert/strict";
import { apiKeyFor, providerFor, providerRegistry, refreshOpenCodeModels, allModels } from "../src/providers/registry.js";

test("resolves OpenCode models through the provider registry", () => {
  const provider = providerFor("gpt-5.6-luna");
  assert.equal(provider.provider, "opencode"); assert.equal(provider.protocol, "responses");
});

test("resolves DeepSeek explicitly instead of the same-named OpenCode model", () => {
  const provider = providerFor("deepseek-v4-flash", "deepseek");
  assert.equal(provider.provider, "deepseek"); assert.match(provider.endpoint, /api\.deepseek\.com/);
});

test("supports arbitrary OpenRouter model ids", () => {
  const provider = providerFor("anthropic/claude-sonnet-4", "openrouter");
  assert.equal(provider.provider, "openrouter"); assert.equal(provider.model, "anthropic/claude-sonnet-4");
});

test("uses provider-specific credentials", () => {
  process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
  assert.equal(apiKeyFor(providerFor("deepseek-v4-pro", "deepseek")), "deepseek-test-key");
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(providerRegistry.some((provider) => provider.id === "openrouter"), true);
});

test("refreshes the OpenCode model catalog from the upstream endpoint", async () => {
  const original = providerRegistry.find((provider) => provider.id === "opencode")!.models;
  const fetcher = (async (input: any, init?: any) => {
    assert.match(String(input), /opencode\.ai\/zen\/go\/v1\/models/);
    return new Response(JSON.stringify({ data: [{ id: "nova-1" }, { id: "gpt-5.6-luna" }, { id: "nova-2" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const refreshed = await refreshOpenCodeModels(fetcher);
  try {
    assert.equal(refreshed, true);
    const opencode = providerRegistry.find((provider) => provider.id === "opencode")!;
    assert.deepEqual(opencode.models.map((item) => item.model), ["gpt-5.6-luna", "nova-1", "nova-2"]);
    assert.equal(providerFor("nova-1").protocol, "chat-completions");
    assert.equal(providerFor("gpt-5.6-luna").protocol, "responses");
    assert.ok(allModels.some((item) => item.model === "nova-1"));
  } finally {
    providerRegistry.find((provider) => provider.id === "opencode")!.models = original;
    allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
  }
});

test("keeps the fallback catalog when the upstream refresh fails", async () => {
  const before = providerRegistry.find((provider) => provider.id === "opencode")!.models.map((item) => item.model);
  const fetcher = (async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as typeof fetch;
  assert.equal(await refreshOpenCodeModels(fetcher), false);
  assert.deepEqual(providerRegistry.find((provider) => provider.id === "opencode")!.models.map((item) => item.model), before);
});

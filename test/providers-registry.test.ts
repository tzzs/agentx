import test from "node:test";
import assert from "node:assert/strict";
import { apiKeyFor, providerFor, providerRegistry, refreshProviderCatalog, allModels } from "../src/providers/registry.js";

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

test("uses provider-specific credentials with the agentx prefix taking precedence", () => {
  process.env.AGENTX_DEEPSEEK_API_KEY = "prefixed-key";
  process.env.DEEPSEEK_API_KEY = "legacy-key";
  assert.equal(apiKeyFor(providerFor("deepseek-v4-pro", "deepseek")), "prefixed-key");
  delete process.env.AGENTX_DEEPSEEK_API_KEY;
  assert.equal(apiKeyFor(providerFor("deepseek-v4-pro", "deepseek")), "legacy-key");
  delete process.env.DEEPSEEK_API_KEY;
  assert.equal(providerRegistry.some((provider) => provider.id === "openrouter"), true);
});

test("refreshes the OpenCode model catalog and enriches limits from the public registry", async () => {
  const original = providerRegistry.find((provider) => provider.id === "opencode")!.models;
  const originalDeepseek = providerRegistry.find((provider) => provider.id === "deepseek")!.models;
  const fetcher = (async (input: any) => {
    if (/models\.dev/.test(String(input))) {
      return new Response(JSON.stringify({
        opencode: { models: { "nova-1": { limit: { context: 262144, output: 32768 }, modalities: { input: ["text", "image"] } }, "gpt-5.6-luna": { limit: { context: 1050000 } } } },
        deepseek: { models: { "deepseek-v4-flash": { limit: { context: 1000000, output: 384000 } } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.match(String(input), /opencode\.ai\/zen\/go\/v1\/models/);
    return new Response(JSON.stringify({ data: [{ id: "nova-1" }, { id: "gpt-5.6-luna" }, { id: "nova-2" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, true);
    const opencode = providerRegistry.find((provider) => provider.id === "opencode")!;
    assert.deepEqual(opencode.models.map((item) => item.model), ["gpt-5.6-luna", "nova-1", "nova-2"]);
    assert.equal(providerFor("nova-1").protocol, "chat-completions");
    assert.equal(providerFor("gpt-5.6-luna").protocol, "responses");
    assert.ok(allModels.some((item) => item.model === "nova-1"));
    // Real limits land on matching ids; unknown ids keep safe defaults.
    assert.equal(providerFor("nova-1").contextWindow, 262144);
    assert.equal(providerFor("nova-1").maxOutputTokens, 32768);
    assert.deepEqual(providerFor("nova-1").modalities, ["text", "image"]);
    assert.equal(providerFor("gpt-5.6-luna").contextWindow, 1050000);
    assert.equal(providerFor("nova-2").contextWindow, undefined);
    // Static providers are enriched through their own models.dev section.
    assert.equal(providerFor("deepseek-v4-flash", "deepseek").contextWindow, 1000000);
    assert.equal(providerFor("deepseek-v4-flash", "deepseek").maxOutputTokens, 384000);
    assert.equal(providerFor("deepseek-v4-pro", "deepseek").contextWindow, undefined);
  } finally {
    providerRegistry.find((provider) => provider.id === "opencode")!.models = original;
    providerRegistry.find((provider) => provider.id === "deepseek")!.models = originalDeepseek;
    allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
  }
});

test("keeps working when only the metadata source is unreachable", async () => {
  const original = providerRegistry.find((provider) => provider.id === "opencode")!.models;
  const fetcher = (async (input: any) => {
    if (/models\.dev/.test(String(input))) throw new Error("offline");
    return new Response(JSON.stringify({ data: [{ id: "solo-model" }] }), { status: 200 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, true);
    assert.equal(providerFor("solo-model").contextWindow, undefined);
  } finally {
    providerRegistry.find((provider) => provider.id === "opencode")!.models = original;
    allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
  }
});

test("applies metadata to static providers even when the list refresh fails", async () => {
  const originalDeepseek = providerRegistry.find((provider) => provider.id === "deepseek")!.models;
  const fetcher = (async (input: any) => {
    if (/models\.dev/.test(String(input))) {
      return new Response(JSON.stringify({ deepseek: { models: { "deepseek-v4-pro": { limit: { context: 986000 } } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "down" }), { status: 500 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, false);
    assert.equal(providerFor("deepseek-v4-pro", "deepseek").contextWindow, 986000);
  } finally {
    providerRegistry.find((provider) => provider.id === "deepseek")!.models = originalDeepseek;
    allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
  }
});

test("keeps the fallback catalog when the upstream refresh fails", async () => {
  const before = providerRegistry.find((provider) => provider.id === "opencode")!.models.map((item) => item.model);
  const fetcher = (async () => new Response(JSON.stringify({ error: "down" }), { status: 500 })) as typeof fetch;
  assert.equal((await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher)).list, false);
  assert.deepEqual(providerRegistry.find((provider) => provider.id === "opencode")!.models.map((item) => item.model), before);
});

function takeSnapshot() { return providerRegistry.map((provider) => ({ id: provider.id, models: provider.models })); }
function restoreSnapshot(snapshot: ReturnType<typeof takeSnapshot>) {
  for (const { id, models } of snapshot) providerRegistry.find((provider) => provider.id === id)!.models = models;
  allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
}

test("backfills models missing from models.dev from the OpenRouter catalog", async () => {
  const snapshot = takeSnapshot();
  const fetcher = (async (input: any) => {
    const url = String(input);
    if (/openrouter\.ai/.test(url)) {
      return new Response(JSON.stringify({ data: [
        { id: "zhipuai/glm-5.3", context_length: 205000, top_provider: { max_completion_tokens: 131072 }, architecture: { input_modalities: ["text", "image", "audio"] } },
        { id: "moonshotai/kimi-k3", context_length: 262144, architecture: { input_modalities: [] } },
        { id: "broken/big", context_length: "lots" },
      ] }), { status: 200 });
    }
    if (/models\.dev/.test(url)) return new Response(JSON.stringify({}), { status: 200 });
    return new Response(JSON.stringify({ data: [{ id: "glm-5.3" }, { id: "kimi-k3" }, { id: "big" }] }), { status: 200 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, true);
    // Suffix match against "vendor/model" ids; non-text/image modalities drop; invalid numbers skip.
    assert.equal(providerFor("glm-5.3").contextWindow, 205000);
    assert.equal(providerFor("glm-5.3").maxOutputTokens, 131072);
    assert.deepEqual(providerFor("glm-5.3").modalities, ["text", "image"]);
    assert.equal(providerFor("kimi-k3").contextWindow, 262144);
    assert.equal(providerFor("kimi-k3").modalities, undefined);
    assert.equal(providerFor("big").contextWindow, undefined);
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("prefers models.dev metadata over OpenRouter field by field", async () => {
  const snapshot = takeSnapshot();
  const fetcher = (async (input: any) => {
    const url = String(input);
    if (/openrouter\.ai/.test(url)) {
      return new Response(JSON.stringify({ data: [{ id: "vendor/nova-1", context_length: 222222, top_provider: { max_completion_tokens: 4096 }, architecture: { input_modalities: ["text"] } }] }), { status: 200 });
    }
    if (/models\.dev/.test(url)) {
      return new Response(JSON.stringify({ opencode: { models: { "nova-1": { limit: { context: 111111 }, modalities: { input: ["text", "image"] } } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ id: "nova-1" }] }), { status: 200 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, true);
    // models.dev wins where present; only its gaps fall through to OpenRouter.
    assert.equal(providerFor("nova-1").contextWindow, 111111);
    assert.equal(providerFor("nova-1").maxOutputTokens, 4096);
    assert.deepEqual(providerFor("nova-1").modalities, ["text", "image"]);
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("keeps working when only the OpenRouter source is unreachable", async () => {
  const snapshot = takeSnapshot();
  const fetcher = (async (input: any) => {
    const url = String(input);
    if (/openrouter\.ai/.test(url)) throw new Error("offline");
    if (/models\.dev/.test(url)) {
      return new Response(JSON.stringify({ deepseek: { models: { "deepseek-v4-flash": { limit: { context: 256000 } } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ id: "solo-model" }] }), { status: 200 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, true);
    assert.equal(providerFor("deepseek-v4-flash", "deepseek").contextWindow, 256000);
    assert.equal(providerFor("solo-model").contextWindow, undefined);
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("skips OpenRouter backfill when a suffix match is ambiguous", async () => {
  const snapshot = takeSnapshot();
  const fetcher = (async (input: any) => {
    const url = String(input);
    if (/openrouter\.ai/.test(url)) {
      return new Response(JSON.stringify({ data: [
        { id: "alpha/twin", context_length: 1000 },
        { id: "beta/twin", context_length: 2000 },
        { id: "gamma/unique", context_length: 3000 },
      ] }), { status: 200 });
    }
    if (/models\.dev/.test(url)) return new Response(JSON.stringify({}), { status: 200 });
    return new Response(JSON.stringify({ data: [{ id: "twin" }, { id: "unique" }] }), { status: 200 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, true);
    assert.equal(providerFor("twin").contextWindow, undefined);
    assert.equal(providerFor("unique").contextWindow, 3000);
  } finally {
    restoreSnapshot(snapshot);
  }
});

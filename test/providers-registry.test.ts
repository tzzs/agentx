import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyFor, credentialEnvName, fetchOpenRouterModels, hydrateOpenCodeCatalog, hydrateOpenRouterCatalog, openRouterCatalogIds, providerById, providerFor, providerRegistry, refreshProviderCatalog, registerCustomProvider, resetOpenCodeCatalogCache, setOpenRouterCatalogIds, unregisterCustomProvider, allModels, withExternalMetadata } from "../src/providers/registry.js";
import { loadOpenCodeModels, saveOpenCodeModels, saveOpenRouterModels } from "../src/runtime.js";

// refreshProviderCatalog/hydrateOpenRouterCatalog/hydrateOpenCodeCatalog read
// and write runtime.json; redirect it to a throwaway directory per test so
// these tests never touch a real user's ~/.config/agentx/runtime.json and a
// persisted OpenCode snapshot from one test can never leak into the next.
// The in-memory OpenCode hydration/TTL guard (openCodeSnapshotFetchedAt) is
// process-wide state that a fresh config dir alone doesn't reset, so it's
// cleared explicitly too — otherwise a live fetch in one test would make
// refreshProviderCatalog skip the fetch the next test expects.
let configDir: string;
test.beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-registry-"));
  process.env.XDG_CONFIG_HOME = configDir;
  resetOpenCodeCatalogCache();
});
test.afterEach(async () => {
  delete process.env.XDG_CONFIG_HOME;
  await rm(configDir, { recursive: true, force: true });
  resetOpenCodeCatalogCache();
});

test("resolves OpenCode models through the provider registry", () => {
  const provider = providerFor("gpt-5.6-luna");
  assert.equal(provider.provider, "opencode"); assert.equal(provider.protocol, "responses");
});

test("resolves DeepSeek explicitly instead of the same-named OpenCode model", () => {
  const provider = providerFor("deepseek-v4-flash", "deepseek");
  assert.equal(provider.provider, "deepseek"); assert.match(provider.endpoint, /api\.deepseek\.com/);
});

test("declares the real DeepSeek context window under both the OpenCode gateway and the direct provider", () => {
  // The reported bug used provider: opencode, model: deepseek-v4-flash — the
  // OpenCode-branded listing, not the direct "deepseek" provider — so the
  // override must apply to both, not just the one models_dev/OpenRouter would
  // otherwise miss for.
  for (const provider of ["opencode", "deepseek"] as const) {
    assert.equal(providerFor("deepseek-v4-flash", provider).contextWindow, 1_000_000);
    assert.equal(providerFor("deepseek-v4-pro", provider).contextWindow, 1_000_000);
  }
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
        // A conflicting context (500000) proves the explicit registry default wins; output still enriches normally.
        deepseek: { models: { "deepseek-v4-flash": { limit: { context: 500000, output: 384000 } } } },
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
    // Static providers are enriched through their own models.dev section, but
    // deepseek-v4-flash/pro carry an explicit registry contextWindow (Codex's
    // catalog otherwise under-declares their real long-context window as
    // 131072) which a live metadata refresh must not override; maxOutputTokens
    // has no such override and still enriches normally.
    assert.equal(providerFor("deepseek-v4-flash", "deepseek").contextWindow, 1000000);
    assert.equal(providerFor("deepseek-v4-flash", "deepseek").maxOutputTokens, 384000);
    assert.equal(providerFor("deepseek-v4-pro", "deepseek").contextWindow, 1000000);
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
  // deepseek-v4-pro/flash carry an explicit contextWindow now, so a synthetic
  // id with no override is what demonstrates plain metadata enrichment here.
  providerRegistry.find((provider) => provider.id === "deepseek")!.models = [
    ...originalDeepseek,
    { provider: "deepseek", model: "deepseek-legacy-test", protocol: "chat-completions", endpoint: "https://x" },
  ];
  allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
  const fetcher = (async (input: any) => {
    if (/models\.dev/.test(String(input))) {
      return new Response(JSON.stringify({ deepseek: { models: { "deepseek-legacy-test": { limit: { context: 986000 } }, "deepseek-v4-pro": { limit: { context: 555000 } } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "down" }), { status: 500 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, false);
    assert.equal(providerFor("deepseek-legacy-test", "deepseek").contextWindow, 986000);
    // A conflicting live entry for deepseek-v4-pro must still lose to the explicit default.
    assert.equal(providerFor("deepseek-v4-pro", "deepseek").contextWindow, 1_000_000);
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
  // deepseek-v4-flash/pro carry an explicit contextWindow now, so a synthetic
  // id with no override is what demonstrates plain metadata enrichment here.
  providerRegistry.find((provider) => provider.id === "deepseek")!.models = [
    ...providerRegistry.find((provider) => provider.id === "deepseek")!.models,
    { provider: "deepseek", model: "deepseek-legacy-test", protocol: "chat-completions", endpoint: "https://x" },
  ];
  allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
  const fetcher = (async (input: any) => {
    const url = String(input);
    if (/openrouter\.ai/.test(url)) throw new Error("offline");
    if (/models\.dev/.test(url)) {
      return new Response(JSON.stringify({ deepseek: { models: { "deepseek-legacy-test": { limit: { context: 256000 } }, "deepseek-v4-flash": { limit: { context: 256000 } } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [{ id: "solo-model" }] }), { status: 200 });
  }) as typeof fetch;
  const refreshed = await refreshProviderCatalog({ provider: "opencode", metadata: true }, fetcher);
  try {
    assert.equal(refreshed.list, true);
    assert.equal(providerFor("deepseek-legacy-test", "deepseek").contextWindow, 256000);
    assert.equal(providerFor("solo-model").contextWindow, undefined);
    // A conflicting live entry for deepseek-v4-flash must still lose to the explicit default.
    assert.equal(providerFor("deepseek-v4-flash", "deepseek").contextWindow, 1_000_000);
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

test("fetchOpenRouterModels fills the interactive picker from the live catalog", async () => {
  const snapshot = takeSnapshot();
  const fetcher = (async (input: any) => {
    assert.match(String(input), /openrouter\.ai\/api\/v1\/models/);
    return new Response(JSON.stringify({ data: [
      { id: "vendor/alpha", context_length: 1000, top_provider: { max_completion_tokens: 512 }, architecture: { input_modalities: ["text"] } },
      { id: "vendor/beta", context_length: 2000 },
      { id: "" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const ids = await fetchOpenRouterModels(fetcher);
    assert.deepEqual(ids, ["vendor/alpha", "vendor/beta"]);
    assert.deepEqual(openRouterCatalogIds(), ["vendor/alpha", "vendor/beta"]);
    assert.equal(openRouterCatalogIds().length >= 2, true);

    // The first catalog id becomes the registry default when no preference is set.
    if (!process.env.OPENROUTER_MODEL) {
      const openrouter = providerRegistry.find((provider) => provider.id === "openrouter")!;
      assert.equal(openrouter.models[0]?.model, "vendor/alpha");
    }
    // Enrichment of a custom id follows the freshly fetched metadata table.
    assert.equal(withExternalMetadata(providerFor("vendor/alpha", "openrouter")).contextWindow, 1000);
    assert.deepEqual(withExternalMetadata(providerFor("vendor/alpha", "openrouter")).modalities, ["text"]);
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("fetchOpenRouterModels keeps the previous catalog when the network fails", async () => {
  const before = openRouterCatalogIds();
  const fetcher = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.deepEqual(await fetchOpenRouterModels(fetcher), before);
});

test("fetchOpenRouterModels keeps the previous catalog on an empty payload", async () => {
  const before = openRouterCatalogIds();
  const fetcher = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await fetchOpenRouterModels(fetcher), before);
});

test("openRouterCatalogIds exposes persisted ids even before a live fetch", async () => {
  const snapshot = takeSnapshot();
  // A metadata refresh that cannot reach the list endpoint persists ids from
  // the OpenRouter table into the catalog cache.
  const fetcher = (async (input: any) => {
    const url = String(input);
    if (/openrouter\.ai/.test(url)) {
      return new Response(JSON.stringify({ data: [{ id: "persisted/vendor-model", context_length: 4096 }] }), { status: 200 });
    }
    if (/models\.dev/.test(url)) return new Response(JSON.stringify({}), { status: 200 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  await refreshProviderCatalog({ metadata: true }, fetcher);
  assert.ok(openRouterCatalogIds().includes("persisted/vendor-model"));
  restoreSnapshot(snapshot);
});

test("hydrateOpenRouterCatalog restores the persisted catalog into an empty in-memory cache", async () => {
  const snapshot = takeSnapshot();
  await saveOpenRouterModels(["disk/vendor-a", "disk/vendor-b"]);
  setOpenRouterCatalogIds([]); // simulate a fresh process with nothing fetched yet
  try {
    assert.deepEqual(await hydrateOpenRouterCatalog(), ["disk/vendor-a", "disk/vendor-b"]);
    assert.deepEqual(openRouterCatalogIds(), ["disk/vendor-a", "disk/vendor-b"]);
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("hydrateOpenRouterCatalog does not overwrite an already-populated cache", async () => {
  const snapshot = takeSnapshot();
  setOpenRouterCatalogIds(["memory/vendor"]);
  await saveOpenRouterModels(["disk/other-vendor"]);
  try {
    assert.deepEqual(await hydrateOpenRouterCatalog(), ["memory/vendor"]);
  } finally {
    restoreSnapshot(snapshot);
  }
});

// registerCustomProvider adds entries that takeSnapshot/restoreSnapshot (above)
// cannot undo — that helper only resets .models on providers that already
// existed at snapshot time, it never removes newly-added ones. Every test
// below must unregister anything it registers instead.

test("registerCustomProvider derives a slug id and an AGENTX_ env var name from the display name", () => {
  try {
    const definition = registerCustomProvider({ name: "My Local LLM", baseUrl: "http://localhost:11434", protocol: "chat-completions" });
    assert.equal(definition.id, "my-local-llm");
    assert.equal(definition.apiKeyEnv, "MY_LOCAL_LLM_API_KEY");
    assert.equal(credentialEnvName(definition), "AGENTX_MY_LOCAL_LLM_API_KEY");
    assert.equal(definition.custom, true);
    assert.equal(definition.models[0].endpoint, "http://localhost:11434/chat/completions");
    assert.equal(definition.models[0].model, "custom-model");
  } finally { unregisterCustomProvider("my-local-llm"); }
});

test("registerCustomProvider builds the right endpoint shape per protocol", () => {
  try {
    assert.equal(registerCustomProvider({ name: "Responses Test", baseUrl: "http://x/", protocol: "responses" }).models[0].endpoint, "http://x/responses");
    assert.equal(registerCustomProvider({ name: "Anthropic Test", baseUrl: "http://x", protocol: "anthropic" }).models[0].endpoint, "http://x/v1/messages");
  } finally { unregisterCustomProvider("responses-test"); unregisterCustomProvider("anthropic-test"); }
});

test("registerCustomProvider avoids clobbering a built-in provider id, but is idempotent for repeated custom registrations", () => {
  let shadowedId: string | undefined;
  try {
    // "OpenCode" slugifies to the built-in id "opencode" — must not shadow it.
    const shadowed = registerCustomProvider({ name: "OpenCode", baseUrl: "http://x", protocol: "chat-completions" });
    shadowedId = shadowed.id;
    assert.notEqual(shadowed.id, "opencode");
    assert.equal(providerById("opencode").custom, undefined);

    // Registering the same custom provider twice updates in place, not a duplicate entry.
    registerCustomProvider({ name: "Repeat Me", baseUrl: "http://a", protocol: "chat-completions", model: "one" });
    registerCustomProvider({ name: "Repeat Me", baseUrl: "http://b", protocol: "responses", model: "two" });
    const matches = providerRegistry.filter((entry) => entry.id === "repeat-me");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].models[0].endpoint, "http://b/responses");
    assert.equal(matches[0].models[0].model, "two");
  } finally { if (shadowedId) unregisterCustomProvider(shadowedId); unregisterCustomProvider("repeat-me"); }
});

test("a registered custom provider resolves through providerFor/apiKeyFor like a built-in one", () => {
  try {
    registerCustomProvider({ name: "Bench Provider", baseUrl: "http://bench.local", protocol: "chat-completions", model: "bench-model" });
    const model = providerFor("bench-model", "bench-provider");
    assert.equal(model.provider, "bench-provider");
    process.env.AGENTX_BENCH_PROVIDER_API_KEY = "bench-key";
    assert.equal(apiKeyFor(model), "bench-key");
    delete process.env.AGENTX_BENCH_PROVIDER_API_KEY;
  } finally { unregisterCustomProvider("bench-provider"); }
});

test("unregisterCustomProvider removes a custom provider but refuses to remove a built-in one", () => {
  registerCustomProvider({ name: "Removable", baseUrl: "http://x", protocol: "chat-completions" });
  assert.ok(providerRegistry.some((entry) => entry.id === "removable"));
  assert.equal(unregisterCustomProvider("removable"), true);
  assert.ok(!providerRegistry.some((entry) => entry.id === "removable"));
  assert.ok(!allModels.some((item) => item.provider === "removable"));

  assert.equal(unregisterCustomProvider("opencode"), false);
  assert.ok(providerRegistry.some((entry) => entry.id === "opencode"));
});

test("refreshProviderCatalog hydrates the OpenRouter cache from disk even when no network fetch is needed", async () => {
  const snapshot = takeSnapshot();
  await saveOpenRouterModels(["disk/only-vendor"]);
  setOpenRouterCatalogIds([]);
  // A provider bound to something other than "opencode" with no metadata
  // request used to early-return without touching the OpenRouter cache at
  // all; the fetcher below must never be called.
  const fetcher = (async () => { throw new Error("must not fetch over the network"); }) as typeof fetch;
  try {
    const refreshed = await refreshProviderCatalog({ provider: "openrouter" }, fetcher);
    assert.deepEqual(refreshed, { list: false, metadata: false });
    assert.deepEqual(openRouterCatalogIds(), ["disk/only-vendor"]);
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("hydrateOpenCodeCatalog restores a persisted OpenCode catalog into a fresh process", async () => {
  const snapshot = takeSnapshot();
  await saveOpenCodeModels({ ids: ["disk-only-model"], fetchedAt: Date.now() });
  try {
    const ids = await hydrateOpenCodeCatalog();
    assert.deepEqual(ids, ["disk-only-model"]);
    assert.equal(providerFor("disk-only-model", "opencode").provider, "opencode");
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("refreshProviderCatalog skips the OpenCode network fetch when a persisted snapshot is still fresh", async () => {
  const snapshot = takeSnapshot();
  await saveOpenCodeModels({ ids: ["fresh-disk-model"], fetchedAt: Date.now() });
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error("must not fetch over the network"); }) as typeof fetch;
  try {
    const refreshed = await refreshProviderCatalog({ provider: "opencode" }, fetcher);
    assert.equal(refreshed.list, false);
    assert.equal(calls, 0);
    assert.ok(providerRegistry.find((provider) => provider.id === "opencode")!.models.some((item) => item.model === "fresh-disk-model"));
  } finally {
    restoreSnapshot(snapshot);
  }
});

test("refreshProviderCatalog re-fetches the OpenCode catalog once a persisted snapshot has expired", async () => {
  const snapshot = takeSnapshot();
  const staleFetchedAt = Date.now() - 25 * 60 * 60 * 1000; // 25h old, past the 24h TTL
  await saveOpenCodeModels({ ids: ["stale-disk-model"], fetchedAt: staleFetchedAt });
  let calls = 0;
  const fetcher = (async (input: any) => {
    if (/opencode\.ai\/zen\/go\/v1\/models/.test(String(input))) { calls++; return new Response(JSON.stringify({ data: [{ id: "refreshed-model" }] }), { status: 200 }); }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  try {
    const refreshed = await refreshProviderCatalog({ provider: "opencode" }, fetcher);
    assert.equal(refreshed.list, true);
    assert.equal(calls, 1);
    assert.deepEqual(providerRegistry.find((provider) => provider.id === "opencode")!.models.map((item) => item.model), ["refreshed-model"]);
    assert.deepEqual((await loadOpenCodeModels())?.ids, ["refreshed-model"]);
  } finally {
    restoreSnapshot(snapshot);
  }
});

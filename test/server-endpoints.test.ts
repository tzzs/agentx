import test from "node:test";
import assert from "node:assert/strict";
import { createConcurrencyGate, estimateInputTokens, startAdapter } from "../src/server.js";
import { createUsageStore } from "../src/usage/storage.js";
import { registerCustomProvider, unregisterCustomProvider } from "../src/providers/registry.js";
import type { Config } from "../src/config.js";

// One custom provider per protocol, registered for the whole file so these
// tests never reach the network or leak registry state.
let chatProvider: string;
let anthropicProvider: string;
test.before(() => {
  chatProvider = registerCustomProvider({ name: "Endpoint Test Chat", baseUrl: "http://chat-upstream.invalid", protocol: "chat-completions", model: "chat-x" }).id;
  anthropicProvider = registerCustomProvider({ name: "Endpoint Test Anthropic", baseUrl: "http://anthropic-upstream.invalid", protocol: "anthropic", model: "claude-y" }).id;
});
test.after(() => { unregisterCustomProvider(chatProvider); unregisterCustomProvider(anthropicProvider); });

function config(overrides: Partial<Config>): Config {
  return { host: "127.0.0.1", port: 0, model: "chat-x", provider: chatProvider, apiKey: "test-key", logLevel: "info", retry: 0, ...overrides };
}

async function adapterFor(overrides: Partial<Config> = {}) {
  const store = await createUsageStore({ backend: "memory" });
  return startAdapter(config(overrides), { store });
}

test("estimateInputTokens charges an image a flat rate instead of counting its base64 as prose", () => {
  // 400 content characters plus the "user" role string, at 4 chars per token.
  const prose = estimateInputTokens({ messages: [{ role: "user", content: "a".repeat(400) }] });
  assert.equal(prose, 101);
  const withImage = estimateInputTokens({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(2_000_000) } }] }] });
  // A 2MB base64 payload would be 500K tokens if counted as text.
  assert.ok(withImage < 5_000, `expected a flat image allowance, got ${withImage}`);
});

test("/v1/messages/count_tokens estimates locally when the upstream protocol has no such endpoint", async () => {
  const adapter = await adapterFor();
  try {
    const response = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
      body: JSON.stringify({ model: "chat-x", messages: [{ role: "user", content: "a".repeat(40) }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 11 });
  } finally { await adapter.close(); }
});

test("/v1/messages/count_tokens asks a native Anthropic upstream for the exact count", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    requestedUrl = url;
    return new Response(JSON.stringify({ input_tokens: 4242 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await adapterFor({ model: "claude-y", provider: anthropicProvider });
  try {
    const response = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
      body: JSON.stringify({ model: "claude-y", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.deepEqual(await response.json(), { input_tokens: 4242 });
    assert.equal(requestedUrl, "http://anthropic-upstream.invalid/v1/messages/count_tokens");
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

test("count_tokens falls back to the estimate when the upstream refuses the request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const adapter = await adapterFor({ model: "claude-y", provider: anthropicProvider });
  try {
    const response = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
      body: JSON.stringify({ model: "claude-y", messages: [{ role: "user", content: "a".repeat(40) }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 11 });
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

test("the model catalog and count_tokens reject an unauthenticated caller", async () => {
  const adapter = await adapterFor();
  try {
    for (const [method, path] of [["GET", "/v1/models"], ["GET", "/v1/models/chat-x"], ["POST", "/v1/messages/count_tokens"]] as const) {
      const response = await fetch(`http://127.0.0.1:${adapter.port}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    // /health stays open: it carries no configuration and is what a supervisor polls.
    assert.equal((await fetch(`http://127.0.0.1:${adapter.port}/health`)).status, 200);
  } finally { await adapter.close(); }
});

test("/v1/models/{id} serves one model and 404s an unknown id", async () => {
  const adapter = await adapterFor();
  const headers = { authorization: `Bearer ${adapter.token}` };
  try {
    const found = await fetch(`http://127.0.0.1:${adapter.port}/v1/models/chat-x`, { headers });
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), { id: "chat-x", object: "model", owned_by: chatProvider });
    const missing = await fetch(`http://127.0.0.1:${adapter.port}/v1/models/nope`, { headers });
    assert.equal(missing.status, 404);
  } finally { await adapter.close(); }
});

test("the concurrency gate admits up to the limit and queues the rest in order", async () => {
  const gate = createConcurrencyGate(2);
  const first = await gate.acquire();
  const second = await gate.acquire();
  let thirdAdmitted = false;
  const third = gate.acquire().then((release) => { thirdAdmitted = true; return release; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdAdmitted, false, "the third request must wait while two are in flight");
  first();
  (await third)();
  assert.equal(thirdAdmitted, true);
  second();
});

test("a zero limit disables the gate entirely", async () => {
  const gate = createConcurrencyGate(0);
  const releases = await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);
  assert.equal(releases.length, 3);
  releases.forEach((release) => release());
});

test("releasing a slot twice does not hand out an extra permit", async () => {
  const gate = createConcurrencyGate(1);
  const release = await gate.acquire();
  release();
  release();
  let secondAdmitted = false;
  const second = gate.acquire().then((r) => { secondAdmitted = true; return r; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondAdmitted, true);
  let thirdAdmitted = false;
  void gate.acquire().then(() => { thirdAdmitted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdAdmitted, false, "the double release must not have freed a second slot");
  (await second)();
});

test("a custom provider's own headers are sent upstream and override the defaults", async () => {
  const id = registerCustomProvider({
    name: "Header Test Gateway", baseUrl: "http://gateway.invalid", protocol: "chat-completions", model: "gw-x",
    headers: { "HTTP-Referer": "https://agentx.example", authorization: "Token gateway-scheme" },
  }).id;
  const originalFetch = globalThis.fetch;
  let seen: Headers | undefined;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    seen = new Headers(init?.headers);
    return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await adapterFor({ model: "gw-x", provider: id });
  try {
    await fetch(`http://127.0.0.1:${adapter.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
      body: JSON.stringify({ model: "gw-x", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(seen?.get("http-referer"), "https://agentx.example");
    // A gateway may want its key in a scheme of its own; the provider's header wins.
    assert.equal(seen?.get("authorization"), "Token gateway-scheme");
  } finally { globalThis.fetch = originalFetch; await adapter.close(); unregisterCustomProvider(id); }
});

test("an unauthenticated proxy request is rejected before it can take a concurrency slot", async () => {
  // With one slot, a request that never authenticates must not be able to sit
  // in the queue ahead of a legitimate one.
  const adapter = await adapterFor({ maxConcurrency: 1 });
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    upstreamCalls++;
    return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const rejected = await Promise.all([0, 1, 2].map(() => fetch(`http://127.0.0.1:${adapter.port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }),
    })));
    assert.deepEqual(rejected.map((r) => r.status), [401, 401, 401]);
    assert.equal(upstreamCalls, 0);
    // The slot is still free for a caller that does authenticate.
    const allowed = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
      body: JSON.stringify({ model: "chat-x", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(upstreamCalls, 1);
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

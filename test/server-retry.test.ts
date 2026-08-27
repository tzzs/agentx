import test from "node:test";
import assert from "node:assert/strict";
import { forwardWithRetry, startAdapter } from "../src/server.js";
import { createUsageStore } from "../src/usage/storage.js";
import type { ProviderModel } from "../src/providers/types.js";

const provider: ProviderModel = { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", endpoint: "http://upstream.invalid/v1/responses" };
const config = { host: "127.0.0.1", port: 0, model: "gpt-5.6-luna", provider: "opencode", apiKey: "test-key", logLevel: "info", retry: 3 };
/** No real waiting: the retry-count/status logic is what these tests exercise, not the backoff timing. */
const instantSleep = async () => {};

function upstreamResponse(status: number): Response {
  return new Response(JSON.stringify({ id: "r1", output: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status });
}

test("retries a 429 twice then succeeds on the third attempt", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return calls < 3 ? upstreamResponse(429) : upstreamResponse(200); }) as typeof fetch;
  try {
    const result = await forwardWithRetry(config, provider, "key", {}, new AbortController().signal, 3, instantSleep);
    assert.equal(result.status, 200);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("gives up after exhausting retries on a persistent 503", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return upstreamResponse(503); }) as typeof fetch;
  try {
    const result = await forwardWithRetry(config, provider, "key", {}, new AbortController().signal, 3, instantSleep);
    assert.equal(result.status, 503);
    assert.equal(calls, 4); // 1 initial attempt + 3 retries
  } finally { globalThis.fetch = originalFetch; }
});

test("does not retry a 500: only 429/502/503/504 are treated as transient", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return upstreamResponse(500); }) as typeof fetch;
  try {
    const result = await forwardWithRetry(config, provider, "key", {}, new AbortController().signal, 3, instantSleep);
    assert.equal(result.status, 500);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("retry: 0 makes exactly one attempt, matching pre-retry behavior", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return upstreamResponse(500); }) as typeof fetch;
  try {
    const result = await forwardWithRetry(config, provider, "key", {}, new AbortController().signal, 0, instantSleep);
    assert.equal(result.status, 500);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("does not retry a non-retryable 4xx status", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return upstreamResponse(400); }) as typeof fetch;
  try {
    const result = await forwardWithRetry(config, provider, "key", {}, new AbortController().signal, 3, instantSleep);
    assert.equal(result.status, 400);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("retries a network-level failure the same as a 5xx", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; if (calls < 2) throw new Error("ECONNRESET"); return upstreamResponse(200); }) as typeof fetch;
  try {
    const result = await forwardWithRetry(config, provider, "key", {}, new AbortController().signal, 3, instantSleep);
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("stops retrying once the client's signal is already aborted", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; throw new Error("simulated network failure"); }) as typeof fetch;
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => forwardWithRetry(config, provider, "key", {}, controller.signal, 3, instantSleep));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("end-to-end: a retried request still reaches the client once the upstream recovers", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    // Only intercept the adapter's own outbound call to the upstream, not the
    // test's inbound call to the local adapter — both URLs contain "/v1/responses".
    if (url.includes("127.0.0.1") || !url.includes("/v1/responses")) return originalFetch(input, init);
    upstreamCalls++;
    return upstreamCalls === 1
      ? new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
      : new Response(JSON.stringify({ id: "r1", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await startAdapter({ ...config, retry: 1 }, { store });
  try {
    const response = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "hi" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.output[0].content[0].text, "OK");
    assert.equal(upstreamCalls, 2);
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

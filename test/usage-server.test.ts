import test from "node:test";
import assert from "node:assert/strict";
import { startAdapter } from "../src/server.js";
import { createUsageStore } from "../src/usage/storage.js";

const config = { host: "127.0.0.1", port: 0, model: "gpt-5.6-luna", provider: "opencode", apiKey: "test-key", logLevel: "info", retry: 0 };

async function call(adapter: Awaited<ReturnType<typeof startAdapter>>, path: string, method = "GET", body?: any, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${adapter.port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, body: parsed, text };
}

test("records usage from a successful non-streaming request, readable through the store", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const path = typeof input === "string" ? input : input.url;
    if (path.includes("127.0.0.1") || !path.includes("/v1/responses")) return originalFetch(input, init);
    if (path.includes("/v1/responses")) {
      return new Response(JSON.stringify({ id: "r1", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 500 });
  }) as typeof fetch;
  const adapter = await startAdapter(config, { store });
  try {
    const sessionId = "session-abc";
    const message = await call(adapter, "/v1/messages", "POST", { model: "gpt-5.6-luna", session_id: sessionId, messages: [{ role: "user", content: "Hi" }] }, { authorization: `Bearer ${adapter.token}`, "x-api-key": adapter.token });
    assert.equal(message.status, 200);
    assert.equal(message.body.usage.input_tokens, 120);
    // Statistics are consumed through `agentx usage` (direct storage reads);
    // the unauthenticated /usage/* HTTP endpoints no longer exist.
    assert.deepEqual(await store.sessionTotals(sessionId), { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    assert.deepEqual(await store.providerStats("all"), [{ provider: "opencode", tokens: 150, requests: 1 }]);
    assert.deepEqual(await store.totals("today"), { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.close();
  }
});

test("records usage from a streaming request using the final chunk", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"He"}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"llo"}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20}}}\n\n'));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  globalThis.fetch = (async (input: any, init?: any) => {
    const path = typeof input === "string" ? input : input.url;
    if (path.includes("127.0.0.1") || !path.includes("/v1/responses")) return originalFetch(input, init);
    if (path.includes("/v1/responses")) return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 500 });
  }) as typeof fetch;
  const adapter = await startAdapter(config, { store });
  try {
    const message = await call(adapter, "/v1/messages", "POST", { model: "gpt-5.6-luna", messages: [{ role: "user", content: "Hi" }], stream: true }, { authorization: `Bearer ${adapter.token}`, "x-api-key": adapter.token });
    assert.equal(message.status, 200);
    assert.match(message.text, /event: message_stop/);
    // No session_id in the request: usage falls back to the adapter's session id.
    assert.deepEqual(await store.sessionTotals(adapter.sessionId), { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.close();
  }
});

test("the removed /usage/* HTTP endpoints answer 404", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const adapter = await startAdapter(config, { store });
  try {
    for (const path of ["/usage/session", "/usage/session/abc", "/usage/providers", "/usage/stats"]) {
      assert.equal((await call(adapter, path)).status, 404, `${path} should be gone`);
    }
  } finally { await adapter.close(); }
});

test("rejects a request body over the configured limit with 413", async () => {
  const store = await createUsageStore({ backend: "memory" });
  // Override the 64MB default down to a size the test can exceed cheaply.
  const adapter = await startAdapter(config, { store, maxBodyBytes: 1024 });
  try {
    const oversized = { model: "gpt-5.6-luna", messages: [{ role: "user", content: "x".repeat(2048) }] };
    const result = await call(adapter, "/v1/messages", "POST", oversized, { authorization: `Bearer ${adapter.token}`, "x-api-key": adapter.token });
    assert.equal(result.status, 413);
  } finally { await adapter.close(); }
});

test("close() force-closes a lingering connection instead of hanging", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const adapter = await startAdapter(config, { store, closeGraceMs: 50 });
  // Open a socket and leave it dangling (no request sent) to simulate a
  // keep-alive connection that never calls back to let server.close() finish
  // on its own; close() must still resolve via the grace-period fallback.
  const { connect } = await import("node:net");
  const socket = connect(adapter.port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const start = Date.now();
  await adapter.close();
  assert.ok(Date.now() - start < 1_000, "close() should resolve shortly after the grace period, not hang");
  socket.destroy();
});

test("honors only provider-compatible requested models", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  let upstreamModel: string | undefined;
  globalThis.fetch = (async (input: any, init?: any) => {
    const path = typeof input === "string" ? input : input.url;
    if (path.includes("127.0.0.1") || !path.includes("/responses")) return originalFetch(input, init);
    upstreamModel = JSON.parse(init.body).model;
    return new Response(JSON.stringify({ id: "r1", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }), { status: 200 });
  }) as typeof fetch;
  const adapter = await startAdapter(config, { store });
  try {
    const result = await call(adapter, "/v1/responses", "POST", { model: "auto", input: "Hi" }, { authorization: `Bearer ${adapter.token}` });
    assert.equal(result.status, 200);
    assert.equal(upstreamModel, "gpt-5.6-luna");
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.close();
  }
});

test("an upstream 200 with an unparseable body surfaces a 5xx and the adapter stays alive", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const path = typeof input === "string" ? input : input.url;
    if (path.includes("127.0.0.1")) return originalFetch(input, init);
    return new Response("<html>gateway garbage</html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const adapter = await startAdapter(config, { store });
  try {
    const message = await call(adapter, "/v1/messages", "POST", { model: "gpt-5.6-luna", messages: [{ role: "user", content: "Hi" }] }, { authorization: `Bearer ${adapter.token}`, "x-api-key": adapter.token });
    assert.equal(message.status, 500);
    assert.match(message.body.error.message, /Internal adapter error/);
    // The rejected handler must not take the adapter process down with it.
    assert.equal((await call(adapter, "/health")).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.close();
  }
});

test("surfaces a DeepSeek insufficient_system_resource stop as a 502, not a 200 end_turn", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const path = typeof input === "string" ? input : input.url;
    if (!path.includes("api.deepseek.com")) return originalFetch(input, init);
    return new Response(JSON.stringify({ id: "c1", choices: [{ message: { content: "Next I will edit the file" }, finish_reason: "insufficient_system_resource" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const deepSeekConfig = { ...config, provider: "deepseek", model: "deepseek-v4-flash" };
  const adapter = await startAdapter(deepSeekConfig, { store });
  try {
    const message = await call(adapter, "/v1/messages", "POST", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] }, { authorization: `Bearer ${adapter.token}`, "x-api-key": adapter.token });
    assert.equal(message.status, 502);
    assert.match(message.body.error.message, /insufficient/);
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.close();
  }
});

test("surfaces a DeepSeek stream that drops mid-turn as an error event, not a 200 end_turn", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  const stream = new ReadableStream({
    start(controller) {
      // The upstream stops after partial content with neither a finish_reason
      // chunk nor [DONE] — a dropped connection, not a completed turn.
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Next I will edit the file"}}]}\n\n'));
      controller.close();
    }
  });
  globalThis.fetch = (async (input: any, init?: any) => {
    const path = typeof input === "string" ? input : input.url;
    if (!path.includes("api.deepseek.com")) return originalFetch(input, init);
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const deepSeekConfig = { ...config, provider: "deepseek", model: "deepseek-v4-flash" };
  const adapter = await startAdapter(deepSeekConfig, { store });
  try {
    const message = await call(adapter, "/v1/messages", "POST", { model: "deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], stream: true }, { authorization: `Bearer ${adapter.token}`, "x-api-key": adapter.token });
    assert.equal(message.status, 200);
    assert.match(message.text, /event: error/);
    assert.doesNotMatch(message.text, /"stop_reason":"end_turn"/);
    assert.doesNotMatch(message.text, /event: message_stop/);
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.close();
  }
});

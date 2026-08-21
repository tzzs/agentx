import test from "node:test";
import assert from "node:assert/strict";
import { startAdapter } from "../src/server.js";
import { createUsageStore } from "../src/usage/storage.js";

const config = { host: "127.0.0.1", port: 0, model: "gpt-5.6-luna", provider: "opencode", apiKey: "test-key", logLevel: "info" };

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

test("records usage from a successful non-streaming request and exposes the query API", async () => {
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
    const session = await call(adapter, "/usage/session?id=session-abc", "GET", undefined, {});
    assert.equal(session.status, 200);
    assert.deepEqual(session.body, { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    const providers = await call(adapter, "/usage/providers", "GET");
    assert.deepEqual(providers.body, [{ provider: "opencode", tokens: 150, requests: 1 }]);
    const stats = await call(adapter, "/usage/stats?period=today", "GET");
    assert.deepEqual(stats.body, { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
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
    const session = await call(adapter, "/usage/session", "GET");
    assert.deepEqual(session.body, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  } finally {
    globalThis.fetch = originalFetch;
    await adapter.close();
  }
});

test("usage endpoints require no auth and return empty aggregates for no records", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const adapter = await startAdapter(config, { store });
  try {
    const session = await call(adapter, "/usage/session", "GET");
    assert.deepEqual(session.body, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    const providers = await call(adapter, "/usage/providers", "GET");
    assert.deepEqual(providers.body, []);
    const stats = await call(adapter, "/usage/stats", "GET");
    assert.deepEqual(stats.body, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  } finally { await adapter.close(); }
});

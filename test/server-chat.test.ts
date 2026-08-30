import test from "node:test";
import assert from "node:assert/strict";
import { startAdapter } from "../src/server.js";
import { createUsageStore } from "../src/usage/storage.js";
import { registerCustomProvider, unregisterCustomProvider } from "../src/providers/registry.js";

// One custom provider per protocol, registered once for the whole file and
// torn down afterward, so these tests never depend on network access or leak
// registry state into other test files.
let anthropicId: string; let responsesId: string; let chatId: string;
test.before(() => {
  anthropicId = registerCustomProvider({ name: "Test Chat->Anthropic Provider", baseUrl: "http://anthropic-upstream.invalid", protocol: "anthropic", model: "claude-x" }).id;
  responsesId = registerCustomProvider({ name: "Test Chat->Responses Provider", baseUrl: "http://responses-upstream.invalid", protocol: "responses", model: "gpt-x" }).id;
  chatId = registerCustomProvider({ name: "Test Chat->Chat Provider", baseUrl: "http://chat-upstream.invalid", protocol: "chat-completions", model: "chat-x" }).id;
});
test.after(() => { unregisterCustomProvider(anthropicId); unregisterCustomProvider(responsesId); unregisterCustomProvider(chatId); });

async function call(adapter: Awaited<ReturnType<typeof startAdapter>>, body: any) {
  const response = await fetch(`http://127.0.0.1:${adapter.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

test("/v1/chat/completions converts to and from Anthropic shape for an anthropic-protocol upstream", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await startAdapter({ host: "127.0.0.1", port: 0, model: "claude-x", provider: anthropicId, apiKey: "test-upstream-key", logLevel: "info", retry: 0 }, { store });
  try {
    const result = await call(adapter, { model: "claude-x", messages: [{ role: "system", content: "Be terse" }, { role: "user", content: "hi" }] });
    assert.equal(result.status, 200);
    // The upstream request was built by toAnthropicRequestFromChat (Anthropic-shaped).
    assert.equal(capturedBody.system, "Be terse");
    assert.deepEqual(capturedBody.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    // The response was converted back to chat completions shape.
    assert.equal(result.body.object, "chat.completion");
    assert.equal(result.body.choices[0].message.content, "OK");
    assert.equal(result.body.usage.prompt_tokens, 3);
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

test("/v1/chat/completions converts to and from Responses shape for a responses-protocol upstream", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "resp_1", object: "response", status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 4, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await startAdapter({ host: "127.0.0.1", port: 0, model: "gpt-x", provider: responsesId, apiKey: "test-upstream-key", logLevel: "info", retry: 0 }, { store });
  try {
    const result = await call(adapter, { model: "gpt-x", messages: [{ role: "system", content: "Be terse" }, { role: "user", content: "hi" }] });
    assert.equal(result.status, 200);
    // The upstream request was built by toResponsesRequestFromChat (Responses-shaped).
    assert.equal(capturedBody.instructions, "Be terse");
    assert.equal(capturedBody.input?.[0]?.role, "user");
    // The response was converted back to chat completions shape.
    assert.equal(result.body.object, "chat.completion");
    assert.equal(result.body.choices[0].message.content, "OK");
    assert.equal(result.body.usage.prompt_tokens, 4);
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

test("/v1/chat/completions passes the request/response through unconverted for a chat-completions upstream", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await startAdapter({ host: "127.0.0.1", port: 0, model: "chat-x", provider: chatId, apiKey: "test-upstream-key", logLevel: "info", retry: 0 }, { store });
  try {
    const result = await call(adapter, { model: "chat-x", messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.status, 200);
    assert.deepEqual(capturedBody.messages, [{ role: "user", content: "hi" }]);
    assert.equal(result.body.object, "chat.completion");
    assert.equal(result.body.choices[0].message.content, "OK");
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

test("/v1/chat/completions streams chat.completion.chunk events for an anthropic-protocol upstream", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    const body = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const adapter = await startAdapter({ host: "127.0.0.1", port: 0, model: "claude-x", provider: anthropicId, apiKey: "test-upstream-key", logLevel: "info", retry: 0 }, { store });
  try {
    const response = await fetch(`http://127.0.0.1:${adapter.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
      body: JSON.stringify({ model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const text = await response.text();
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.match(text, /"delta":\{"content":"Hi"\}/);
    assert.match(text, /data: \[DONE\]/);
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

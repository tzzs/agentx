import test from "node:test";
import assert from "node:assert/strict";
import { startAdapter } from "../src/server.js";
import { createUsageStore } from "../src/usage/storage.js";
import { registerCustomProvider, unregisterCustomProvider } from "../src/providers/registry.js";

// Registers one "anthropic"-protocol custom provider for the whole file and
// tears it down afterward, so these tests never depend on network access or
// leak registry state into other test files.
let providerId: string;
test.before(() => {
  providerId = registerCustomProvider({ name: "Test Anthropic Provider", baseUrl: "http://anthropic-upstream.invalid", protocol: "anthropic", model: "claude-x" }).id;
});
test.after(() => { unregisterCustomProvider(providerId); });

async function call(adapter: Awaited<ReturnType<typeof startAdapter>>, path: string, body: any) {
  const response = await fetch(`http://127.0.0.1:${adapter.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adapter.token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

test("/v1/messages sends x-api-key/anthropic-version upstream and passes the response through unconverted", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Headers | undefined;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await startAdapter({ host: "127.0.0.1", port: 0, model: "claude-x", provider: providerId, apiKey: "test-upstream-key", logLevel: "info", retry: 0 }, { store });
  try {
    const result = await call(adapter, "/v1/messages", { model: "claude-x", messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.status, 200);
    // Passthrough: the Anthropic-shaped response comes back byte-identical, not converted.
    assert.deepEqual(result.body.content, [{ type: "text", text: "OK" }]);
    assert.equal(capturedHeaders?.get("x-api-key"), "test-upstream-key");
    assert.equal(capturedHeaders?.get("anthropic-version"), "2023-06-01");
    assert.match(capturedHeaders?.get("authorization") ?? "", /Bearer test-upstream-key/);
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

test("/v1/responses converts to and from Anthropic shape for a Codex-facing request against the same custom provider", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("127.0.0.1")) return originalFetch(input, init);
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const adapter = await startAdapter({ host: "127.0.0.1", port: 0, model: "claude-x", provider: providerId, apiKey: "test-upstream-key", logLevel: "info", retry: 0 }, { store });
  try {
    const result = await call(adapter, "/v1/responses", { model: "claude-x", instructions: "Be terse", input: "hi" });
    assert.equal(result.status, 200);
    // The upstream request was built by toAnthropicRequest (Anthropic-shaped, not Responses-shaped).
    assert.equal(capturedBody.system, "Be terse");
    assert.deepEqual(capturedBody.messages, [{ role: "user", content: "hi" }]);
    // The response was converted back to Responses shape by fromAnthropicResponse.
    assert.equal(result.body.object, "response");
    assert.deepEqual(result.body.output, [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] }]);
  } finally { globalThis.fetch = originalFetch; await adapter.close(); }
});

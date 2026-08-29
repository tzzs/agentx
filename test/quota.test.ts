import test from "node:test";
import assert from "node:assert/strict";
import { parseDeepSeekBalance, parseOpenRouterKey, queryProviderUsage, runQuotaCommand } from "../src/quota.js";
import { registerCustomProvider, unregisterCustomProvider } from "../src/providers/registry.js";

test("parses DeepSeek balance", () => {
  const result = parseDeepSeekBalance({ balance_infos: [{ currency: "CNY", total_balance: "12.5" }] });
  assert.equal(result.remaining, 12.5); assert.equal(result.unit, "CNY");
});
test("parses OpenRouter usage and remaining limit", () => {
  const result = parseOpenRouterKey({ data: { usage: 2.5, limit: 10, limit_remaining: 7.5 } });
  assert.equal(result.used, 2.5); assert.equal(result.remaining, 7.5); assert.equal(result.total, 10);
});

test("runQuotaCommand reports opencode as unsupported without any network call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("must not fetch for opencode"); }) as typeof fetch;
  try {
    const { output, exitCode } = await runQuotaCommand("opencode");
    const result = JSON.parse(output);
    assert.equal(result.supported, false);
    assert.equal(exitCode, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("runQuotaCommand rejects when the provider credential is missing in non-interactive mode", async () => {
  delete process.env.AGENTX_DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  await assert.rejects(() => runQuotaCommand("deepseek"), /API key not found/i);
});

test("queryProviderUsage reports a provider without a quota endpoint as unsupported instead of throwing", async () => {
  // Custom providers (and any other id without a registered `quota.endpoint`)
  // used to fall through to a thrown Error; they now share opencode's
  // "not exposed" branch instead of needing special-cased handling.
  const { id } = registerCustomProvider({ name: "My LLM", baseUrl: "https://example.invalid", protocol: "chat-completions" });
  try {
    const result = await queryProviderUsage(id, "some-key");
    assert.equal(result.supported, false);
    assert.equal(result.success, false);
    assert.match(result.message ?? "", /does not currently expose/);
  } finally { unregisterCustomProvider(id); }
});

test("runQuotaCommand queries the provider and sets exitCode 1 on failure", async () => {
  process.env.AGENTX_DEEPSEEK_API_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as typeof fetch;
  try {
    const { output, exitCode } = await runQuotaCommand("deepseek");
    const result = JSON.parse(output);
    assert.equal(result.success, false);
    assert.equal(exitCode, 1);
  } finally { globalThis.fetch = originalFetch; delete process.env.AGENTX_DEEPSEEK_API_KEY; }
});

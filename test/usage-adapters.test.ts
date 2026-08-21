import test from "node:test";
import assert from "node:assert/strict";
import { extractResponsesUsage, extractChatUsage } from "../src/providers/usage/openai.js";
import { extractAnthropicUsage } from "../src/providers/usage/anthropic.js";
import { extractGeminiUsage } from "../src/providers/usage/google.js";
import { extractUsage, usageFormatFor } from "../src/providers/usage/index.js";
import { capabilitiesFor } from "../src/usage/capabilities.js";

const ctx = { provider: "openai", model: "gpt-4o" };

test("maps OpenAI Responses usage to the common format", () => {
  const usage = extractResponsesUsage({ usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } } }, ctx);
  assert.deepEqual(usage, { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 10, reasoningTokens: 5 });
});

test("maps OpenAI Chat Completions usage to the common format", () => {
  const usage = extractChatUsage({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }, ctx);
  assert.deepEqual(usage, { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 50, totalTokens: 150 });
});

test("returns null when the response has no usage", () => {
  assert.equal(extractResponsesUsage({ output: [] }, ctx), null);
  assert.equal(extractChatUsage({ choices: [] }, ctx), null);
  assert.equal(extractAnthropicUsage({ content: [] }, ctx), null);
  assert.equal(extractGeminiUsage({ candidates: [] }, ctx), null);
});

test("defaults missing token fields to zero and computes totals", () => {
  const usage = extractResponsesUsage({ usage: { input_tokens: 100, output_tokens: 50 } }, ctx);
  assert.equal(usage!.totalTokens, 150);
  assert.equal(usage!.cachedInputTokens, undefined);
});

test("maps Anthropic Messages usage including cache tokens", () => {
  const usage = extractAnthropicUsage({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } }, { provider: "anthropic", model: "claude-sonnet-4" });
  assert.equal(usage!.inputTokens, 100); assert.equal(usage!.outputTokens, 50);
  assert.equal(usage!.cachedInputTokens, 20); assert.equal(usage!.cacheWriteTokens, 30);
});

test("maps Anthropic cache_creation tokens to cacheWrite, not cachedInput", () => {
  const usage = extractAnthropicUsage({ usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 30 } }, { provider: "anthropic", model: "claude-sonnet-4" });
  assert.equal(usage!.cachedInputTokens, undefined);
  assert.equal(usage!.cacheWriteTokens, 30);
});

test("maps Google Gemini usageMetadata", () => {
  const usage = extractGeminiUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150, cachedContentTokenCount: 10, thoughtsTokenCount: 5 } }, { provider: "google", model: "gemini-2.5-pro" });
  assert.equal(usage!.inputTokens, 100); assert.equal(usage!.outputTokens, 50);
  assert.equal(usage!.cachedInputTokens, 10); assert.equal(usage!.reasoningTokens, 5);
});

test("dispatches by provider protocol", () => {
  assert.equal(usageFormatFor({ provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", endpoint: "x" }), "responses");
  assert.equal(usageFormatFor({ provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", endpoint: "x" }), "chat-completions");
  assert.equal(extractUsage({ usage: { input_tokens: 10, output_tokens: 2 } }, { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", endpoint: "x" }, {})!.inputTokens, 10);
  assert.equal(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } }, { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", endpoint: "x" }, {})!.inputTokens, 10);
});

test("reports provider capabilities", () => {
  assert.equal(capabilitiesFor("opencode").supportsUsage, true);
  assert.equal(capabilitiesFor("opencode").supportsStreamingUsage, true);
  assert.equal(capabilitiesFor("deepseek").supportsCacheTokens, true);
  assert.equal(capabilitiesFor("openrouter").supportsCacheTokens, false);
  assert.deepEqual(capabilitiesFor("unknown-provider"), { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: false });
});

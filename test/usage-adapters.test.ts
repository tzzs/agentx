import test from "node:test";
import assert from "node:assert/strict";
import { extractResponsesUsage, extractChatUsage, mapResponsesUsage, mapChatUsage } from "../src/providers/usage/openai.js";
import { extractAnthropicUsage, mapAnthropicUsage } from "../src/providers/usage/anthropic.js";
import { extractUsage } from "../src/providers/usage/index.js";

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

test("bare-usage-object mappers operate on the usage object directly, not a response envelope", () => {
  // extract*Usage are thin wrappers around these that unwrap `response.usage`
  // first; the mappers themselves must accept the bare usage object, since
  // src/streaming/common.ts calls them directly on a raw usage chunk.
  const responses = mapResponsesUsage({ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } }, ctx);
  assert.deepEqual(responses, { provider: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2 });
  const chat = mapChatUsage({ prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } }, ctx);
  assert.deepEqual(chat, { provider: "openai", model: "gpt-4o", inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 3 });
  const anthropic = mapAnthropicUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 }, { provider: "anthropic", model: "claude-sonnet-4" });
  assert.deepEqual(anthropic, { provider: "anthropic", model: "claude-sonnet-4", inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 4 });
  assert.equal(mapResponsesUsage(undefined, ctx), null);
});

test("dispatches by provider protocol", () => {
  assert.equal(extractUsage({ usage: { input_tokens: 10, output_tokens: 2 } }, { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", endpoint: "x" }, {})!.inputTokens, 10);
  assert.equal(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 2 } }, { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", endpoint: "x" }, {})!.inputTokens, 10);
});

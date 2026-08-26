import test from "node:test";
import assert from "node:assert/strict";
import { pipeResponsesStream, pipeChatStreamToResponses, pipeResponsesPassthrough } from "../src/streaming/index.js";
import type { TokenUsage } from "../src/usage/types.js";
import { renderUsageStats } from "../src/usage/cli.js";
import { openAIPricing, anthropicPricing, googlePricing, calculateCost } from "../src/usage/pricing/index.js";

function collect(options: NonNullable<Parameters<typeof pipeResponsesStream>[3]>) {
  const usages: TokenUsage[] = [];
  return { ...options, onUsage: (usage: TokenUsage) => { usages.push(usage); }, usages };
}

test("pipeResponsesStream reports usage from the final chunk", async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20}}}\n\n',
    "data: [DONE]\n\n"
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {}, on() {} };
  const opts = collect({ provider: "opencode", model: "gpt-5.6-luna", protocol: "responses" });
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna", opts);
  assert.equal(opts.usages.length, 1);
  assert.deepEqual(opts.usages[0], { provider: "opencode", model: "gpt-5.6-luna", inputTokens: 100, outputTokens: 20, totalTokens: 120 });
});

test("pipeResponsesStream records cached and reasoning tokens from usage details", async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":80},"output_tokens_details":{"reasoning_tokens":12}}}}\n\n'
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {}, on() {} };
  const opts = collect({ provider: "opencode", model: "gpt-5.6-luna", protocol: "responses" });
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna", opts);
  assert.deepEqual(opts.usages[0], { provider: "opencode", model: "gpt-5.6-luna", inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 80, reasoningTokens: 12 });
});

test("pipeResponsesStream reads top-level chat completions usage for chat upstreams", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":50,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":32}}}\n\n',
    "data: [DONE]\n\n"
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {}, on() {} };
  const opts = collect({ provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  await pipeResponsesStream(upstream, output as never, "deepseek-v4-pro", opts);
  assert.deepEqual(opts.usages[0], { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 32 });
});

test("pipeResponsesStream estimates usage when the provider sends none", async () => {
  const chunks = ['data: {"type":"response.output_text.delta","delta":"A"}\n\n', 'data: {"type":"response.output_text.delta","delta":"B"}\n\n', "data: [DONE]\n\n"];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {}, on() {} };
  const opts = collect({ provider: "opencode", model: "gpt-5.6-luna", protocol: "responses" });
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna", opts);
  assert.equal(opts.usages[0].estimated, true);
  assert.equal(opts.usages[0].outputTokens, 2);
});

test("pipeChatStreamToResponses reports usage from the final chunk", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":50,"completion_tokens":10,"total_tokens":60}}\n\n',
    "data: [DONE]\n\n"
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {}, on() {} };
  const usages: TokenUsage[] = [];
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", onUsage: (usage) => usages.push(usage) });
  assert.deepEqual(usages[0], { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 50, outputTokens: 10, totalTokens: 60 });
});

test("pipeChatStreamToResponses records cached and reasoning tokens when provided", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":50,"completion_tokens":10,"total_tokens":60,"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":6}}}\n\n',
    "data: [DONE]\n\n"
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {}, on() {} };
  const usages: TokenUsage[] = [];
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", onUsage: (usage) => usages.push(usage) });
  assert.deepEqual(usages[0], { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 40, reasoningTokens: 6 });
});

test("pipeResponsesPassthrough forwards chunks and captures usage", async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
    "data: [DONE]\n\n"
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {}, on() {} };
  const usages: TokenUsage[] = [];
  await pipeResponsesPassthrough(upstream, output as never, "gpt-5.6-luna", { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", onUsage: (usage) => usages.push(usage) });
  assert.equal(text.includes("output_text"), true);
  assert.deepEqual(usages[0], { provider: "opencode", model: "gpt-5.6-luna", inputTokens: 5, outputTokens: 2, totalTokens: 7 });
});

test("pipeResponsesPassthrough records cached and reasoning tokens from usage details", async () => {
  const chunks = [
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":90,"output_tokens":8,"input_tokens_details":{"cached_tokens":70},"output_tokens_details":{"reasoning_tokens":5}}}}\n\n'
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  const output = { writeHead() {}, write() {}, end() {}, on() {} };
  const usages: TokenUsage[] = [];
  await pipeResponsesPassthrough(upstream, output as never, "gpt-5.6-luna", { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", onUsage: (usage) => usages.push(usage) });
  assert.deepEqual(usages[0], { provider: "opencode", model: "gpt-5.6-luna", inputTokens: 90, outputTokens: 8, totalTokens: 98, cachedInputTokens: 70, reasoningTokens: 5 });
});

test("pipeResponsesPassthrough estimates usage from deltas when the provider sends none", async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"A"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"B"}\n\n',
    "data: [DONE]\n\n"
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  const output = { writeHead() {}, write() {}, end() {}, on() {} };
  const usages: TokenUsage[] = [];
  await pipeResponsesPassthrough(upstream, output as never, "gpt-5.6-luna", { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", onUsage: (usage) => usages.push(usage) });
  assert.equal(usages[0].estimated, true);
  assert.equal(usages[0].outputTokens, 2);
});

test("renders usage statistics for the CLI", () => {
  const text = renderUsageStats({
    period: "all",
    totals: { inputTokens: 120000, outputTokens: 35000, totalTokens: 155000 },
    models: [{ provider: "openai", model: "gpt-5", inputTokens: 90000, outputTokens: 30000, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, tokens: 120000, requests: 35 }, { provider: "anthropic", model: "claude-sonnet-4", inputTokens: 25000, outputTokens: 9000, cachedTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 0, tokens: 35000, requests: 20 }]
  });
  assert.match(text, /Token Usage \(All time\)/);
  assert.match(text, /openai/);
  assert.match(text, /120K/);
  assert.match(text, /Total:\s+155K/);
});

test("pricing providers calculate estimated cost", () => {
  const usage = { provider: "openai", model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  assert.ok(openAIPricing.calculate("gpt-4o", usage) > 0);
  assert.ok(anthropicPricing.calculate("claude-sonnet-4", usage) > 0);
  assert.ok(googlePricing.calculate("gemini-2.5-pro", usage) > 0);
  assert.ok(calculateCost("unknown", "model", usage) > 0);
  assert.equal(openAIPricing.calculate("gpt-4o", { provider: "openai", model: "gpt-4o", inputTokens: 0, outputTokens: 0, totalTokens: 0 }), 0);
});

test("cached input is billed as a subset of input, not on top of it", () => {
  const usage = { provider: "openai", model: "gpt-4o", inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cachedInputTokens: 900 };
  // (1000-900) * $5/M + 900 * $2.50/M = $0.00275
  assert.equal(openAIPricing.calculate("gpt-4o", usage), 0.00275);
});

test("stream pipes capture cache and reasoning tokens from final usage", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":80},"completion_tokens_details":{"reasoning_tokens":3}}}\n\n',
    "data: [DONE]\n\n"
  ];
  const upstream = new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } }));
  let text = ""; const output = { writeHead() {}, write(v: string) { text += v; }, end() {}, on() {} };
  const usages: TokenUsage[] = [];
  await pipeChatStreamToResponses(upstream, output as never, "gpt-4o", { provider: "openai", model: "gpt-4o", protocol: "chat-completions", onUsage: (u) => usages.push(u) });
  assert.deepEqual(usages[0], { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 80, reasoningTokens: 3 });
});

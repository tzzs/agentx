import test from "node:test";
import assert from "node:assert/strict";
import { pipeAnthropicStreamToChat, pipeChatPassthrough, pipeResponsesStreamToChat } from "../src/streaming/index.js";
import type { TokenUsage } from "../src/usage/types.js";

function sink() {
  let text = "";
  return {
    get text() { return text; },
    writeHead() {},
    write(value: string) { text += value; },
    end() {},
    on() {},
  };
}

function scriptedUpstream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }));
}

function failingUpstream(firstChunk: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(firstChunk)); controller.error(new Error("connection reset")); } }));
}

test("pipeAnthropicStreamToChat translates text deltas into chat.completion.chunk deltas", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const output = sink();
  let usage: TokenUsage | undefined;
  await pipeAnthropicStreamToChat(upstream, output as never, "claude-x", { provider: "custom", model: "claude-x", protocol: "anthropic", onUsage: (value) => { usage = value; } });
  assert.match(output.text, /"object":"chat\.completion\.chunk"/);
  assert.match(output.text, /"delta":\{"content":"Hi"\}/);
  assert.match(output.text, /"finish_reason":"stop"/);
  assert.match(output.text, /data: \[DONE\]/);
  assert.equal(usage?.inputTokens, 5); assert.equal(usage?.outputTokens, 2);
});

test("pipeAnthropicStreamToChat translates a streamed tool_use block into a chat tool_calls delta", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"bash"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"pwd\\"}"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const output = sink();
  await pipeAnthropicStreamToChat(upstream, output as never, "claude-x");
  assert.match(output.text, /"id":"call-1"/); assert.match(output.text, /"name":"bash"/);
  assert.match(output.text, /"arguments":"\{\\"cmd\\":\\"pwd\\"\}"/);
  assert.match(output.text, /"finish_reason":"tool_calls"/);
});

test("pipeAnthropicStreamToChat treats a stream with no message_stop as a dropped connection", async () => {
  const upstream = scriptedUpstream(['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n']);
  const output = sink();
  await pipeAnthropicStreamToChat(upstream, output as never, "claude-x");
  assert.match(output.text, /\[error:/);
});

test("pipeAnthropicStreamToChat surfaces a mid-stream connection failure", async () => {
  const upstream = failingUpstream('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
  const output = sink();
  await pipeAnthropicStreamToChat(upstream, output as never, "claude-x");
  assert.match(output.text, /\[error: connection reset\]/);
});

test("pipeResponsesStreamToChat translates Responses text deltas into chat.completion.chunk deltas", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
  ]);
  const output = sink();
  let usage: TokenUsage | undefined;
  await pipeResponsesStreamToChat(upstream, output as never, "gpt-5.6-luna", { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", onUsage: (value) => { usage = value; } });
  assert.match(output.text, /"delta":\{"content":"Hi"\}/);
  assert.match(output.text, /"finish_reason":"stop"/);
  assert.equal(usage?.inputTokens, 3); assert.equal(usage?.outputTokens, 1);
});

test("pipeResponsesStreamToChat translates a streamed function call into a chat tool_calls delta", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"bash"}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","call_id":"call-1","delta":"{\\"cmd\\":\\"pwd\\"}"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  ]);
  const output = sink();
  await pipeResponsesStreamToChat(upstream, output as never, "gpt-5.6-luna");
  assert.match(output.text, /"id":"call-1"/); assert.match(output.text, /"name":"bash"/);
  assert.match(output.text, /"finish_reason":"tool_calls"/);
});

test("pipeResponsesStreamToChat converts an in-band response.failed payload into an error chunk", async () => {
  const upstream = scriptedUpstream(['data: {"type":"response.failed","response":{"error":{"message":"provider overloaded"}}}\n\n']);
  const output = sink();
  await pipeResponsesStreamToChat(upstream, output as never, "gpt-5.6-luna");
  assert.match(output.text, /provider overloaded/);
});

test("pipeChatPassthrough forwards chat completions chunks byte-for-byte and captures usage", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
    "data: [DONE]\n\n",
  ]);
  const output = sink();
  let usage: TokenUsage | undefined;
  await pipeChatPassthrough(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", onUsage: (value) => { usage = value; } });
  assert.match(output.text, /"delta":\{"content":"Hi"\}/);
  assert.match(output.text, /data: \[DONE\]/);
  assert.equal(usage?.inputTokens, 4); assert.equal(usage?.outputTokens, 2); assert.equal(usage?.estimated, undefined);
});

test("pipeChatPassthrough estimates usage from deltas when the provider sends none", async () => {
  const upstream = scriptedUpstream(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', "data: [DONE]\n\n"]);
  const output = sink();
  let usage: TokenUsage | undefined;
  await pipeChatPassthrough(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions", onUsage: (value) => { usage = value; } });
  assert.equal(usage?.estimated, true); assert.equal(usage?.outputTokens, 1);
});

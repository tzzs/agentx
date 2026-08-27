import test from "node:test";
import assert from "node:assert/strict";
import { pipeAnthropicPassthrough, pipeAnthropicStreamToResponses, pipeChatStreamToResponses, pipeResponsesPassthrough, pipeResponsesStream } from "../src/streaming/index.js";
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

function failingUpstream(firstChunk: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(firstChunk)); controller.error(new Error("connection reset")); } }));
}

test("translates response text deltas into Anthropic events", async () => {
  const upstream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.output_text.done","text":"OK"}\n\n')); controller.close(); } }));
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna");
  assert.match(output.text, /event: message_start/); assert.equal((output.text.match(/"text":"OK"/g) ?? []).length, 1); assert.match(output.text, /event: message_stop/);
});
test("translates streamed function calls into Anthropic tool use", async () => {
  const chunks = [
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"bash"}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","call_id":"call-1","delta":"{\\"command\\":\\"pwd\\"}"}\n\n'
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna");
  assert.match(output.text, /"type":"tool_use"/); assert.match(output.text, /"name":"bash"/); assert.match(output.text, /"partial_json"/); assert.match(output.text, /command/); assert.match(output.text, /"stop_reason":"tool_use"/);
});
test("emits an Anthropic error event when the upstream stream fails mid-flight", async () => {
  const upstream = failingUpstream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna", { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses" });
  assert.match(output.text, /event: error/); assert.match(output.text, /connection reset/);
});
test("emits response.failed when a Chat Completions upstream stream fails mid-flight", async () => {
  const upstream = failingUpstream('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  const output = sink();
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.match(output.text, /event: response\.failed/); assert.match(output.text, /connection reset/);
});
test("terminates a passthrough stream with response.failed on upstream failure", async () => {
  const upstream = failingUpstream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n');
  const output = sink();
  await pipeResponsesPassthrough(upstream, output as never, "gpt-5.6-luna");
  assert.match(output.text, /event: response\.failed/); assert.match(output.text, /connection reset/);
});

function scriptedUpstream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }));
}

test("ends the stream with an error when a Chat Completions upstream reports failure in-band", async () => {
  const upstream = scriptedUpstream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'data: {"error":{"message":"quota exceeded"}}\n\n']);
  const output = sink();
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-pro");
  assert.match(output.text, /event: response\.failed/); assert.match(output.text, /quota exceeded/); assert.doesNotMatch(output.text, /response\.completed/);
});

test("converts an in-band response.failed payload into an Anthropic error event", async () => {
  const upstream = scriptedUpstream(['data: {"type":"response.output_text.delta","delta":"par"}\n\n', 'data: {"type":"response.failed","response":{"error":{"code":"overloaded","message":"provider overloaded"}}}\n\n']);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna", { provider: "opencode", model: "gpt-5.6-luna", protocol: "responses" });
  assert.match(output.text, /event: error/); assert.match(output.text, /provider overloaded/); assert.doesNotMatch(output.text, /event: message_stop/);
});

test("keeps parallel Chat Completions tool calls in separate blocks", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"read","arguments":"{\\"file\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-b","function":{"name":"write","arguments":"{\\"text\\":\\"hi\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "deepseek-v4-pro", { provider: "opencode", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.equal((output.text.match(/"type":"tool_use"/g) ?? []).length, 3);
  assert.equal((output.text.match(/"name":"read"/g) ?? []).length, 2);
  assert.equal((output.text.match(/"name":"write"/g) ?? []).length, 1);
  assert.match(output.text, /partial_json":"\{\\"file\\":/); // first chunk of call-a
  assert.match(output.text, /partial_json":"\\"a\.txt\\"}"/); // continuation lands in its own later block
  assert.match(output.text, /"stop_reason":"tool_use"/); assert.match(output.text, /event: message_stop/);
});

test("reports max_tokens when a Chat Completions stream hits the length limit", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"trunc"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    "data: [DONE]\n\n"
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.match(output.text, /"stop_reason":"max_tokens"/); assert.doesNotMatch(output.text, /"stop_reason":"end_turn"/);
});
test("surfaces DeepSeek insufficient_system_resource as an error instead of a silent end_turn", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"Next I will edit"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"insufficient_system_resource"}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  const output = sink();
  const diagnostics: string[] = [];
  await pipeResponsesStream(upstream, output as never, "deepseek-v4-flash", { provider: "deepseek", model: "deepseek-v4-flash", protocol: "chat-completions", onDiagnostic: (message) => diagnostics.push(message) });
  assert.match(output.text, /event: error/); assert.match(output.text, /insufficient/);
  assert.doesNotMatch(output.text, /"stop_reason":"end_turn"/); assert.doesNotMatch(output.text, /event: message_stop/);
  assert.ok(diagnostics.some((message) => message.includes("insufficient_system_resource")));
});
test("surfaces a content_filter stop as an error for Codex-style Chat Completions streams", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  const output = sink();
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.match(output.text, /event: response\.failed/); assert.match(output.text, /filtered/);
  assert.doesNotMatch(output.text, /response\.completed/);
});
test("treats a Chat Completions stream that ends with neither finish_reason nor [DONE] as a dropped connection", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"Next I will edit the file"}}]}\n\n',
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "deepseek-v4-flash", { provider: "deepseek", model: "deepseek-v4-flash", protocol: "chat-completions" });
  assert.match(output.text, /event: error/);
  assert.doesNotMatch(output.text, /"stop_reason":"end_turn"/); assert.doesNotMatch(output.text, /event: message_stop/);
});
test("treats a Codex-facing Chat Completions stream with no finish_reason or [DONE] as a dropped connection", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"Next I will edit the file"}}]}\n\n',
  ]);
  const output = sink();
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-flash", { provider: "deepseek", model: "deepseek-v4-flash", protocol: "chat-completions" });
  assert.match(output.text, /event: response\.failed/);
  assert.doesNotMatch(output.text, /response\.completed/);
});
test("does not fail a text-only Chat Completions stream that closes with [DONE] but no finish_reason", async () => {
  // Some gateways (e.g. under load) omit the finish_reason chunk but still send
  // a proper [DONE]; that alone must still read as a normal, complete turn.
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"All done"}}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "deepseek-v4-flash", { provider: "deepseek", model: "deepseek-v4-flash", protocol: "chat-completions" });
  assert.match(output.text, /"stop_reason":"end_turn"/); assert.match(output.text, /event: message_stop/);
  assert.doesNotMatch(output.text, /event: error/);
});

test("keeps text after tool calls in its own block instead of appending to tool JSON", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"bash"}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","call_id":"call-1","delta":"{}"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"Done!"}\n\n'
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna");
  const starts = output.text.match(/"type":"content_block_start","index":\d+,"content_block":\{"type":"[a-z_]+"/g) ?? [];
  assert.equal(starts.length, 2); // one tool_use block + one later text block
  assert.match(output.text, /"content_block":\{"type":"text","text":""\}/);
  assert.equal((output.text.match(/"partial_json"/g) ?? []).length, 1);
});

test("announces repeated chat tool deltas exactly once", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"read"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  const output = sink();
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-pro");
  assert.equal((output.text.match(/event: response\.output_item\.added/g) ?? []).length, 1);
});

test("translates reasoning summaries into Anthropic thinking blocks before text", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking hard"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"Answer"}\n\n'
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna");
  assert.match(output.text, /"content_block":\{"type":"thinking","thinking":""\}/);
  assert.match(output.text, /"type":"thinking_delta","thinking":"thinking hard"/);
  const thinkingStart = output.text.indexOf('"type":"thinking"');
  const stop = output.text.indexOf("event: content_block_stop");
  const textStart = output.text.indexOf('content_block":{"type":"text"');
  assert.ok(thinkingStart >= 0 && thinkingStart < stop && stop < textStart, "thinking block must close before the text block opens");
});
test("maps chat reasoning_content into Anthropic thinking blocks", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"reasoning_content":"ponder"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.match(output.text, /"type":"thinking_delta","thinking":"ponder"/);
  assert.match(output.text, /"type":"text_delta","text":"Hi"/);
});
test("reports cache read tokens in the final Anthropic usage", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":80}}}}\n\n'
  ]);
  const output = sink();
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna");
  assert.match(output.text, /"cache_read_input_tokens":80/);
});
test("translates chat reasoning into Responses reasoning events for Codex clients", async () => {
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"reasoning_content":"step one"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  const output = sink();
  await pipeChatStreamToResponses(upstream, output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.match(output.text, /"item":\{"type":"reasoning","id":"rs_/);
  assert.match(output.text, /event: response\.reasoning_summary_text\.delta\ndata: .*"delta":"step one"/);
  assert.match(output.text, /event: response\.output_text\.delta/);
  assert.match(output.text, /"summary":\[\{"type":"summary_text","text":"step one"\}\]/);
});
test("finalizes the assistant message item for Codex turn collection", async () => {
  // Codex builds the turn from response.output_item.done events; a message
  // that is only announced via text deltas would be lost (or displaced by
  // the reasoning item).
  const upstream = scriptedUpstream([
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n'
  ]);
  const output = sink();
  await pipeChatStreamToResponses(upstream, output as never, "ox-alpha-free", { provider: "opencode", model: "ox-alpha-free", protocol: "chat-completions" });
  assert.match(output.text, /event: response\.output_item\.added\ndata: .*"item":\{"type":"message","id":"msg_/);
  assert.match(output.text, /event: response\.output_item\.done\ndata: \{"type":"response\.output_item\.done","output_index":0,"item":\{"type":"message","id":"msg_.*?"status":"completed","content":\[\{"type":"output_text","text":"ok"\}\]\}/);
  assert.match(output.text, /"usage":\{"input_tokens":2,"output_tokens":1,"total_tokens":3\}/);
});

// --- pipeAnthropicPassthrough: Claude Code <-> a custom provider that already speaks Anthropic ---

test("pipeAnthropicPassthrough forwards a native Anthropic SSE stream byte-for-byte and captures usage", async () => {
  const chunks = [
    'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ];
  const upstream = scriptedUpstream(chunks);
  const output = sink();
  const usages: TokenUsage[] = [];
  await pipeAnthropicPassthrough(upstream, output as never, "claude-x", { provider: "custom", model: "claude-x", protocol: "anthropic", onUsage: (usage) => usages.push(usage) });
  // Byte-faithful: every upstream chunk appears verbatim in the forwarded output.
  for (const chunk of chunks) assert.ok(output.text.includes(chunk));
  assert.equal(usages[0].inputTokens, 10);
  assert.equal(usages[0].outputTokens, 5);
});

test("pipeAnthropicPassthrough emits an Anthropic error event on upstream failure", async () => {
  const upstream = failingUpstream('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
  const output = sink();
  await pipeAnthropicPassthrough(upstream, output as never, "claude-x");
  assert.match(output.text, /event: error/); assert.match(output.text, /connection reset/);
});

// --- pipeAnthropicStreamToResponses: Codex <-> a custom provider that already speaks Anthropic ---

test("pipeAnthropicStreamToResponses translates text deltas into Responses events", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const output = sink();
  await pipeAnthropicStreamToResponses(upstream, output as never, "claude-x");
  assert.match(output.text, /event: response\.output_text\.delta\ndata: .*"delta":"Hi"/);
  assert.match(output.text, /event: response\.completed/);
  assert.match(output.text, /data: \[DONE\]/);
});

test("pipeAnthropicStreamToResponses translates a tool_use content block into a Responses function call", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"bash"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":\\"ls\\"}"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const output = sink();
  await pipeAnthropicStreamToResponses(upstream, output as never, "claude-x");
  assert.match(output.text, /"type":"function_call"/); assert.match(output.text, /"name":"bash"/);
  assert.match(output.text, /event: response\.function_call_arguments\.delta/); assert.match(output.text, /cmd/);
});

test("pipeAnthropicStreamToResponses translates thinking deltas into Responses reasoning events, ahead of the answer text", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"pondering"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const output = sink();
  await pipeAnthropicStreamToResponses(upstream, output as never, "claude-x");
  assert.match(output.text, /event: response\.reasoning_summary_text\.delta\ndata: .*"delta":"pondering"/);
  assert.match(output.text, /event: response\.output_text\.delta\ndata: .*"delta":"Answer"/);
  assert.ok(output.text.indexOf('"pondering"') < output.text.indexOf('"delta":"Answer"'));
});

test("pipeAnthropicStreamToResponses reports input/output/cached usage from message_start and message_delta", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":50}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9,"cache_read_input_tokens":40}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const output = sink();
  const usages: TokenUsage[] = [];
  await pipeAnthropicStreamToResponses(upstream, output as never, "claude-x", { provider: "custom", model: "claude-x", protocol: "anthropic", onUsage: (usage) => usages.push(usage) });
  assert.equal(usages[0].inputTokens, 50);
  assert.equal(usages[0].outputTokens, 9);
  assert.equal(usages[0].cachedInputTokens, 40);
});

test("pipeAnthropicStreamToResponses emits response.failed when the upstream stream fails mid-flight", async () => {
  const upstream = failingUpstream('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
  const output = sink();
  await pipeAnthropicStreamToResponses(upstream, output as never, "claude-x");
  assert.match(output.text, /event: response\.failed/); assert.match(output.text, /connection reset/);
});

test("pipeAnthropicStreamToResponses ends the stream with an error on an in-band error event", async () => {
  const upstream = scriptedUpstream([
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
    'data: {"type":"error","error":{"type":"overloaded_error","message":"provider overloaded"}}\n\n',
  ]);
  const output = sink();
  await pipeAnthropicStreamToResponses(upstream, output as never, "claude-x");
  assert.match(output.text, /event: response\.failed/); assert.match(output.text, /provider overloaded/); assert.doesNotMatch(output.text, /response\.completed/);
});

test("pipeAnthropicStreamToResponses treats a stream with no message_stop as a dropped connection", async () => {
  const upstream = scriptedUpstream(['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n']);
  const output = sink();
  await pipeAnthropicStreamToResponses(upstream, output as never, "claude-x");
  assert.match(output.text, /event: response\.failed/); assert.doesNotMatch(output.text, /response\.completed/);
});
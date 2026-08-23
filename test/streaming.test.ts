import test from "node:test";
import assert from "node:assert/strict";
import { pipeChatStreamToResponses, pipeResponsesPassthrough, pipeResponsesStream } from "../src/streaming.js";

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
    'data: [DONE]\n\n'
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

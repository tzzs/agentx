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

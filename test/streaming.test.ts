import test from "node:test";
import assert from "node:assert/strict";
import { pipeResponsesStream } from "../src/streaming.js";

test("translates response text deltas into Anthropic events", async () => {
  const upstream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.output_text.done","text":"OK"}\n\n')); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {} };
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna");
  assert.match(text, /event: message_start/); assert.equal((text.match(/"text":"OK"/g) ?? []).length, 1); assert.match(text, /event: message_stop/);
});
test("translates streamed function calls into Anthropic tool use", async () => {
  const chunks = [
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"bash"}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","call_id":"call-1","delta":"{\\"command\\":\\"pwd\\"}"}\n\n'
  ];
  const upstream = new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
  let text = ""; const output = { writeHead() {}, write(value: string) { text += value; }, end() {} };
  await pipeResponsesStream(upstream, output as never, "gpt-5.6-luna");
  assert.match(text, /"type":"tool_use"/); assert.match(text, /"name":"bash"/); assert.match(text, /"partial_json"/); assert.match(text, /command/); assert.match(text, /"stop_reason":"tool_use"/);
});

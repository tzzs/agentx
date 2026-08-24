import test from "node:test";
import assert from "node:assert/strict";
import { pipeChatStreamToResponses, pipeResponsesStream } from "../src/streaming.js";

function streamOf(chunks: string[]) {
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } }));
}

function capture() { let buffer = ""; return { get text() { return buffer; }, output: { writeHead() {}, write(value: string) { buffer += value; }, end() {} } }; }

test("translates response text deltas into Anthropic events", async () => {
  const upstream = streamOf(['data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.output_text.done","text":"OK"}\n\n']);
  const cap = capture();
  await pipeResponsesStream(upstream, cap.output as never, "gpt-5.6-luna");
  assert.match(cap.text, /event: message_start/); assert.equal((cap.text.match(/"text":"OK"/g) ?? []).length, 1); assert.match(cap.text, /event: message_stop/);
});
test("translates streamed function calls into Anthropic tool use", async () => {
  const chunks = [
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"bash"}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","call_id":"call-1","delta":"{\\"command\\":\\"pwd\\"}"}\n\n'
  ];
  const cap = capture();
  await pipeResponsesStream(streamOf(chunks), cap.output as never, "gpt-5.6-luna");
  assert.match(cap.text, /"type":"tool_use"/); assert.match(cap.text, /"name":"bash"/); assert.match(cap.text, /"partial_json"/); assert.match(cap.text, /command/); assert.match(cap.text, /"stop_reason":"tool_use"/);
});
test("translates reasoning summaries into Anthropic thinking blocks before text", async () => {
  const chunks = [
    'data: {"type":"response.reasoning_summary_part.added"}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking hard"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"Answer"}\n\n'
  ];
  const cap = capture();
  await pipeResponsesStream(streamOf(chunks), cap.output as never, "gpt-5.6-luna");
  assert.match(cap.text, /"content_block":\{"type":"thinking","thinking":""\}/);
  assert.match(cap.text, /"type":"thinking_delta","thinking":"thinking hard"/);
  const thinkingStart = cap.text.indexOf('"type":"thinking"');
  const stop = cap.text.indexOf("event: content_block_stop");
  const textStart = cap.text.indexOf('content_block":{"type":"text"');
  assert.ok(thinkingStart >= 0 && thinkingStart < stop && stop < textStart, "thinking block must close before the text block opens");
});
test("maps chat reasoning_content into Anthropic thinking blocks", async () => {
  const chunks = ['data: {"choices":[{"delta":{"reasoning_content":"ponder"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'];
  const cap = capture();
  await pipeResponsesStream(streamOf(chunks), cap.output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.match(cap.text, /"type":"thinking_delta","thinking":"ponder"/);
  assert.match(cap.text, /"type":"text_delta","text":"Hi"/);
});
test("reports cache read tokens in the final Anthropic usage", async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":80}}}}\n\n'
  ];
  const cap = capture();
  await pipeResponsesStream(streamOf(chunks), cap.output as never, "gpt-5.6-luna");
  assert.match(cap.text, /"cache_read_input_tokens":80/);
});
test("translates chat reasoning into Responses reasoning events for Codex clients", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"step one"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
    "data: [DONE]\n\n"
  ];
  const cap = capture();
  await pipeChatStreamToResponses(streamOf(chunks), cap.output as never, "deepseek-v4-pro", { provider: "deepseek", model: "deepseek-v4-pro", protocol: "chat-completions" });
  assert.match(cap.text, /"item":\{"type":"reasoning","id":"rs_/);
  assert.match(cap.text, /event: response\.reasoning_summary_text\.delta\ndata: .*"delta":"step one"/);
  assert.match(cap.text, /event: response\.output_text\.delta/);
  assert.match(cap.text, /"summary":\[\{"type":"summary_text","text":"step one"\}\]/);
});

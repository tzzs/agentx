import test from "node:test";
import assert from "node:assert/strict";
import { fromResponsesResponse, toResponsesRequest } from "../src/providers.js";

test("converts Anthropic request to Responses request", () => {
  assert.deepEqual(toResponsesRequest({ system: "Be concise", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }, "gpt-5.6-luna"), { model: "gpt-5.6-luna", input: [{ role: "user", content: "Hi" }], instructions: "Be concise", max_output_tokens: 10 });
});
test("converts Responses response to Anthropic response", () => {
  const result = fromResponsesResponse({ id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 2, output_tokens: 1 } }, "gpt-5.6-luna");
  assert.deepEqual(result.content, [{ type: "text", text: "OK" }]); assert.equal(result.stop_reason, "end_turn");
});
test("converts Anthropic text blocks to Responses content blocks", () => {
  const result = toResponsesRequest({ messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }, "gpt-5.6-luna") as any;
  assert.deepEqual(result.input[0].content, [{ type: "input_text", text: "Hi" }]);
});
test("strips thinking blocks from requests echoed back by Claude Code", () => {
  const result = toResponsesRequest({ messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "redacted_thinking", data: "x" }, { type: "text", text: "Running" }] },
    { role: "user", content: "go" }
  ] }, "gpt-5.6-luna") as any;
  assert.deepEqual(result.input, [
    { role: "assistant", content: [{ type: "output_text", text: "Running" }] },
    { role: "user", content: "go" }
  ]);
});
test("maps cached input tokens and reasoning summaries into the Anthropic response", () => {
  const result = fromResponsesResponse({
    id: "r1",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "let me think" }] },
      { type: "message", content: [{ type: "output_text", text: "OK" }] }
    ],
    usage: { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 40 } }
  }, "gpt-5.6-luna") as any;
  assert.deepEqual(result.content, [{ type: "thinking", thinking: "let me think" }, { type: "text", text: "OK" }]);
  assert.equal(result.usage.cache_read_input_tokens, 40);
  assert.equal(result.usage.cache_creation_input_tokens, 0);
});

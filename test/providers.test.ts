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

import test from "node:test";
import assert from "node:assert/strict";
import { fromResponsesResponse, toResponsesRequest } from "../src/convert/index.js";

test("converts tools and tool results", () => {
  const result = toResponsesRequest({ tools: [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp" }] }] }, "gpt-5.6-luna");
  assert.deepEqual(result.tools, [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }]);
  assert.deepEqual((result.input as any[])[0], { type: "function_call", call_id: "call-1", name: "bash", arguments: '{"command":"pwd"}' });
  assert.deepEqual((result.input as any[])[1], { type: "function_call_output", call_id: "call-1", output: "/tmp" });
});
test("converts function calls to tool use", () => {
  const result = fromResponsesResponse({ id: "r2", output: [{ type: "function_call", call_id: "call-1", name: "bash", arguments: '{"command":"pwd"}' }] }, "gpt-5.6-luna") as any;
  assert.deepEqual(result.content, [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }]); assert.equal(result.stop_reason, "tool_use");
});

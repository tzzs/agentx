import test from "node:test";
import assert from "node:assert/strict";
import { fromChatResponse, fromChatResponseToResponses, providerFor, toChatCompletionsRequest, toChatRequest } from "../src/catalog.js";

test("routes DeepSeek models through chat completions", () => {
  assert.equal(providerFor("deepseek-v4-flash").protocol, "chat-completions");
  assert.equal((toChatRequest({ messages: [{ role: "user", content: "Hi" }] }, "deepseek-v4-flash") as any).messages[0].content, "Hi");
});
test("converts chat completion tool calls", () => {
  const result = fromChatResponse({ id: "c1", choices: [{ message: { tool_calls: [{ id: "x", function: { name: "bash", arguments: "{}" } }] } }] }, "deepseek-v4-pro") as any;
  assert.equal(result.stop_reason, "tool_use"); assert.equal(result.content[0].name, "bash");
});
test("converts Responses requests for Chat Completions providers", () => {
  const result = toChatCompletionsRequest({ instructions: "Be brief", input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }], max_output_tokens: 12, stream: true }, "deepseek-v4-pro") as any;
  assert.deepEqual(result.messages, [{ role: "system", content: "Be brief" }, { role: "user", content: "Hi" }]); assert.equal(result.max_tokens, 12); assert.equal(result.stream, true);
});
test("converts Anthropic tool use and tool result to chat completions", () => {
  const result = toChatRequest({ messages: [
    { role: "assistant", content: [{ type: "text", text: "Running" }, { type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp" }] }
  ] }, "deepseek-v4-flash") as any;
  assert.deepEqual(result.messages, [
    { role: "assistant", content: "Running" },
    { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "/tmp" }
  ]);
});
test("converts system and plain text messages for chat completions", () => {
  const result = toChatRequest({ system: [{ type: "text", text: "Be brief" }], messages: [{ role: "user", content: "Hi" }] }, "deepseek-v4-pro") as any;
  assert.deepEqual(result.messages, [{ role: "system", content: "Be brief" }, { role: "user", content: "Hi" }]);
});
test("converts Chat Completions responses to Responses", () => {
  const result = fromChatResponseToResponses({ id: "c2", choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, "deepseek-v4-pro") as any;
  assert.equal(result.object, "response"); assert.deepEqual(result.output[0].content, [{ type: "output_text", text: "OK" }]); assert.equal(result.usage.input_tokens, 2);
});

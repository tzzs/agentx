import test from "node:test";
import assert from "node:assert/strict";
import { fromChatResponse, fromChatResponseToResponses, providerFor, toChatCompletionsRequest, toChatRequest } from "../src/catalog.js";
import { toResponsesRequest } from "../src/providers.js";
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
test("maps chat reasoning content and cached tokens for Anthropic clients", () => {
  const result = fromChatResponse({ id: "c3", choices: [{ message: { reasoning_content: "pondering", content: "Hi" } }], usage: { prompt_tokens: 30, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 24 } } }, "deepseek-v4-pro") as any;
  assert.deepEqual(result.content, [{ type: "thinking", thinking: "pondering" }, { type: "text", text: "Hi" }]);
  assert.equal(result.usage.cache_read_input_tokens, 24);
});
test("maps chat reasoning content and usage details for Codex clients", () => {
  const result = fromChatResponseToResponses({ id: "c4", choices: [{ message: { reasoning_content: "pondering", content: "Hi" } }], usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34, prompt_tokens_details: { cached_tokens: 24 }, completion_tokens_details: { reasoning_tokens: 3 } } }, "deepseek-v4-pro") as any;
  assert.deepEqual(result.output[0], { type: "reasoning", id: result.output[0].id, summary: [{ type: "summary_text", text: "pondering" }] });
  assert.equal(result.usage.input_tokens_details.cached_tokens, 24);
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 3);
});
test("keeps structured parts when converting Responses input for Chat Completions", () => {
  const result = toChatCompletionsRequest({ input: [{ role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] }] }, "deepseek-v4-pro") as any;
  assert.deepEqual(result.messages[0].content, [
    { type: "text", text: "Look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }
  ]);
});
test("converts Anthropic images into Chat Completions image parts", () => {
  const result = toChatRequest({ messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] }, "deepseek-v4-pro") as any;
  assert.deepEqual(result.messages[0].content, [
    { type: "text", text: "What is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }
  ]);
});
test("converts Anthropic images into Responses input_image parts", () => {
  const result = toResponsesRequest({ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/cat.png" } }] }] }, "gpt-5.6-luna") as any;
  assert.deepEqual(result.input[0].content, [{ type: "input_image", image_url: "https://example.com/cat.png" }]);
});
test("chat responses with array content convert without [object Object]", () => {
  const result = fromChatResponseToResponses({ choices: [{ message: { content: [{ type: "text", text: "Hi" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] } }] }, "deepseek-v4-pro") as any;
  assert.deepEqual(result.output[0].content, [{ type: "output_text", text: "Hi" }]);
});
test("forwards sampling parameters to chat completions", () => {
  const result = toChatRequest({ messages: [{ role: "user", content: "Hi" }], temperature: 0.2, top_p: 0.9, stop_sequences: ["STOP"] } as any, "deepseek-v4-pro") as any;
  assert.equal(result.temperature, 0.2); assert.equal(result.top_p, 0.9); assert.deepEqual(result.stop, ["STOP"]);
});
test("omits sampling parameters when not requested", () => {
  const result = toChatRequest({ messages: [{ role: "user", content: "Hi" }] }, "deepseek-v4-pro") as any;
  assert.equal("temperature" in result, false); assert.equal("top_p" in result, false); assert.equal("stop" in result, false);
});
test("forwards temperature and top_p to Responses requests", () => {
  const result = toResponsesRequest({ messages: [{ role: "user", content: "Hi" }], temperature: 0.5, top_p: 0.8 } as any, "gpt-5.6-luna") as any;
  assert.equal(result.temperature, 0.5); assert.equal(result.top_p, 0.8);
});

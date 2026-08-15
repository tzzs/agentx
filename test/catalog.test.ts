import test from "node:test";
import assert from "node:assert/strict";
import { fromChatResponse, providerFor, toChatRequest } from "../src/catalog.js";

test("routes DeepSeek models through chat completions", () => {
  assert.equal(providerFor("deepseek-v4-flash").protocol, "chat-completions");
  assert.equal((toChatRequest({ messages: [{ role: "user", content: "Hi" }] }, "deepseek-v4-flash") as any).messages[0].content, "Hi");
});
test("converts chat completion tool calls", () => {
  const result = fromChatResponse({ id: "c1", choices: [{ message: { tool_calls: [{ id: "x", function: { name: "bash", arguments: "{}" } }] } }] }, "deepseek-v4-pro") as any;
  assert.equal(result.stop_reason, "tool_use"); assert.equal(result.content[0].name, "bash");
});

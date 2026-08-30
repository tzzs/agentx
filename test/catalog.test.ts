import test from "node:test";
import assert from "node:assert/strict";
import { honorRequestedModel, providerFor } from "../src/catalog.js";
import { chatResponseFailure, fromAnthropicResponseToChat, fromChatResponse, fromChatResponseToResponses, fromResponsesResponseToChat, toAnthropicRequestFromChat, toChatCompletionsRequest, toChatRequest, toResponsesRequest, toResponsesRequestFromChat } from "../src/convert/index.js";
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
test("flattens namespace tools and drops server-side built-ins for Codex clients", () => {
  // Codex v0.149 sends web_search built-ins and multi-agent namespace containers
  // alongside plain function tools; nameless entries must never reach chat upstreams.
  const result = toChatCompletionsRequest({
    input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
    tools: [
      { type: "function", name: "shell", description: "Runs a command", strict: false, parameters: { type: "object", properties: {} } },
      { type: "web_search", external_web_access: false },
      { type: "namespace", name: "multi_agent_v1", description: "Sub-agents.", tools: [
        { type: "function", name: "close_agent", description: "Closes an agent", strict: false, parameters: { type: "object", properties: {} } },
        { type: "web_search", external_web_access: false },
      ] },
      { type: "custom", name: "apply_patch", format: { type: "grammar" } },
    ],
  }, "ox-alpha-free") as any;
  assert.deepEqual(result.tools, [
    { type: "function", function: { name: "shell", description: "Runs a command", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "close_agent", description: "Closes an agent", parameters: { type: "object", properties: {} } } },
  ]);
});
test("omits the tools field when no tool converts for chat upstreams", () => {
  const result = toChatCompletionsRequest({ input: "Hi", tools: [{ type: "web_search", external_web_access: false }] }, "deepseek-v4-flash") as any;
  assert.equal("tools" in result, false);
});
test("converts Anthropic tool use and tool result to chat completions", () => {
  // Text and the tool call it led to must stay one assistant message; splitting
  // them (the old behavior) loses the DeepSeek reasoning_content anchor below.
  const result = toChatRequest({ messages: [
    { role: "assistant", content: [{ type: "text", text: "Running" }, { type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp" }] }
  ] }, "deepseek-v4-flash") as any;
  assert.deepEqual(result.messages, [
    { role: "assistant", content: "Running", tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] },
    { role: "tool", tool_call_id: "call-1", content: "/tmp" }
  ]);
});
test("keeps DeepSeek reasoning_content anchored to the message with its tool call", () => {
  const result = toChatRequest({ messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "check cwd first" }, { type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }] },
  ] }, "deepseek-v4-flash") as any;
  assert.deepEqual(result.messages, [
    { role: "assistant", content: null, reasoning_content: "check cwd first", tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] },
  ]);
});
test("drops thinking blocks for non-DeepSeek chat completions providers", () => {
  const result = toChatRequest({ messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: "Hi" }] },
  ] }, "ox-alpha-free") as any;
  assert.deepEqual(result.messages, [{ role: "assistant", content: "Hi" }]);
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
test("honors client-requested models the provider serves", () => {
  assert.equal(honorRequestedModel("deepseek-v4-flash", "gpt-5.6-luna", "opencode"), "deepseek-v4-flash");
});
test("falls back to the configured model for unknown or foreign requests", () => {
  assert.equal(honorRequestedModel("claude-haiku-4-5", "gpt-5.6-luna", "opencode"), "gpt-5.6-luna");
  // gpt-5.6-luna is not served by DeepSeek, so a pinned provider rejects it.
  assert.equal(honorRequestedModel("gpt-5.6-luna", "deepseek-v4-pro", "deepseek"), "deepseek-v4-pro");
  assert.equal(honorRequestedModel("auto", "gpt-5.6-luna", "opencode"), "gpt-5.6-luna");
  assert.equal(honorRequestedModel(undefined, "gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(honorRequestedModel("gpt-5.6-luna", "gpt-5.6-luna", "opencode"), "gpt-5.6-luna");
});
test("keeps OpenRouter passthrough semantics for arbitrary ids", () => {
  assert.equal(honorRequestedModel("zoo/any-model", "openai/gpt-4o-mini", "openrouter"), "zoo/any-model");
});
test("treats normal finish reasons as no failure", () => {
  for (const reason of [undefined, null, "stop", "length", "tool_calls", "function_call"]) {
    assert.equal(chatResponseFailure({ choices: [{ finish_reason: reason }] }), undefined);
  }
});
test("flags DeepSeek's insufficient_system_resource and content_filter as failures, not a silent end_turn", () => {
  assert.match(chatResponseFailure({ choices: [{ finish_reason: "insufficient_system_resource" }] }) ?? "", /insufficient/);
  assert.match(chatResponseFailure({ choices: [{ finish_reason: "content_filter" }] }) ?? "", /filtered/);
  assert.match(chatResponseFailure({ choices: [{ finish_reason: "weird_new_reason" }] }) ?? "", /weird_new_reason/);
});
test("converts a chat completions request (system, tool_calls, tool result, tool_choice, image) to Anthropic shape", () => {
  const result = toAnthropicRequestFromChat({
    messages: [
      { role: "system", content: "Be brief" },
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      { role: "assistant", content: "Running", tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "/tmp" },
    ],
    max_tokens: 100, stop: "STOP", tool_choice: { type: "function", function: { name: "bash" } },
    tools: [{ type: "function", function: { name: "bash", description: "Runs a command", parameters: { type: "object", properties: {} } } }],
  }, "claude-x") as any;
  assert.equal(result.system, "Be brief");
  assert.deepEqual(result.messages[0], { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] });
  assert.deepEqual(result.messages[1], { role: "assistant", content: [{ type: "text", text: "Running" }, { type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }] });
  assert.deepEqual(result.messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp" }] });
  assert.deepEqual(result.stop_sequences, ["STOP"]);
  assert.deepEqual(result.tool_choice, { type: "tool", name: "bash" });
  assert.deepEqual(result.tools, [{ name: "bash", description: "Runs a command", input_schema: { type: "object", properties: {} } }]);
});
test("converts a chat completions request to Responses shape by reusing toAnthropicRequestFromChat/toResponsesRequest", () => {
  const result = toResponsesRequestFromChat({ messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hi" }], max_tokens: 50 }, "gpt-5.6-luna") as any;
  assert.equal(result.instructions, "Be brief");
  assert.equal(result.max_output_tokens, 50);
  assert.deepEqual(result.input, [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }]);
});
test("converts an Anthropic response (text, tool_use, usage) to chat completions shape", () => {
  const result = fromAnthropicResponseToChat({ id: "msg_1", content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } }, "claude-x") as any;
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }]);
  assert.equal(result.usage.prompt_tokens, 10); assert.equal(result.usage.completion_tokens, 5);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 3);
});
test("converts a Responses response to chat completions shape by reusing fromResponsesResponse/fromAnthropicResponseToChat", () => {
  const result = fromResponsesResponseToChat({ id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }], usage: { input_tokens: 4, output_tokens: 2 } }, "gpt-5.6-luna") as any;
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].message.content, "Hi");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage.total_tokens, 6);
});
test("gates DeepSeek thinking and reasoning_effort behind the provider/model check", () => {
  const deepseek = toChatRequest({ thinking: { type: "disabled" }, messages: [{ role: "user", content: "Hi" }] } as any, "deepseek-v4-flash") as any;
  assert.deepEqual(deepseek.thinking, { type: "disabled" });
  const other = toChatRequest({ thinking: { type: "disabled" }, messages: [{ role: "user", content: "Hi" }] } as any, "ox-alpha-free") as any;
  assert.equal("thinking" in other, false);
  // tool_choice is a standard Chat Completions field; it applies regardless of provider.
  const toolChoice = toChatRequest({ tool_choice: "any", messages: [{ role: "user", content: "Hi" }] } as any, "ox-alpha-free") as any;
  assert.equal(toolChoice.tool_choice, "required");
});

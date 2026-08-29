import test from "node:test";
import assert from "node:assert/strict";
import { chatThinking, chatToolChoice, fromAnthropicResponse, fromResponsesResponse, reasoningEffort, responsesResponseFailure, responsesToolChoice, toAnthropicRequest, toResponsesRequest } from "../src/convert/index.js";

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

test("normalizes Claude and DeepSeek effort names to Chat Completions values", () => {
  assert.equal(reasoningEffort({ output_config: { effort: "low" } }), "low");
  assert.equal(reasoningEffort({ output_config: { effort: "max" } }), "max");
  assert.equal(reasoningEffort({ output_config: { effort: "medium" } }), "high");
  assert.equal(reasoningEffort({ output_config: { effort: "xhigh" } }), "high");
  assert.equal(reasoningEffort({ output_config: { effort: "ultracode" } }), "high");
  assert.equal(reasoningEffort({ reasoning: { effort: "high" } }), "high");
  assert.equal(reasoningEffort({ output_config: { effort: "none" } }), undefined);
  assert.equal(reasoningEffort({}), undefined);
});

test("converts Anthropic thinking controls to DeepSeek's enabled/disabled shape", () => {
  assert.deepEqual(chatThinking({ thinking: { type: "disabled" } }), { type: "disabled" });
  assert.deepEqual(chatThinking({ thinking: { type: "enabled" } }), { type: "enabled" });
  assert.deepEqual(chatThinking({ thinking: { type: "adaptive" } }), { type: "enabled" });
  assert.deepEqual(chatThinking({ reasoning: { effort: "none" } }), { type: "disabled" });
  assert.deepEqual(chatThinking({ reasoning: { effort: "high" } }), { type: "enabled" });
  assert.equal(chatThinking({}), undefined);
});

test("converts Anthropic tool_choice variants to Chat Completions variants", () => {
  assert.equal(chatToolChoice("none"), "none");
  assert.equal(chatToolChoice("auto"), "auto");
  assert.equal(chatToolChoice("any"), "required");
  assert.equal(chatToolChoice("required"), "required");
  assert.equal(chatToolChoice("bogus"), undefined);
  assert.deepEqual(chatToolChoice({ type: "tool", name: "bash" }), { type: "function", function: { name: "bash" } });
  assert.deepEqual(chatToolChoice({ type: "function", function: { name: "bash" } }), { type: "function", function: { name: "bash" } });
  assert.equal(chatToolChoice({ type: "none" }), "none");
  assert.equal(chatToolChoice(undefined), undefined);
});

test("converts Anthropic tool_choice variants to Responses variants", () => {
  assert.equal(responsesToolChoice("any"), "required");
  assert.equal(responsesToolChoice("required"), "required");
  assert.deepEqual(responsesToolChoice({ type: "tool", name: "bash" }), { type: "function", name: "bash" });
  assert.deepEqual(responsesToolChoice({ type: "function", function: { name: "bash" } }), { type: "function", name: "bash" });
  assert.equal(responsesToolChoice({ type: "bogus" }), undefined);
});

test("forwards thinking/effort/tool_choice into Responses requests", () => {
  const disabled = toResponsesRequest({ thinking: { type: "disabled" }, messages: [{ role: "user", content: "Hi" }] }, "gpt-5.6-luna") as any;
  assert.deepEqual(disabled.reasoning, { effort: "none" });
  const low = toResponsesRequest({ output_config: { effort: "low" }, messages: [{ role: "user", content: "Hi" }] }, "gpt-5.6-luna") as any;
  assert.deepEqual(low.reasoning, { effort: "low" });
  const forced = toResponsesRequest({ tool_choice: { type: "tool", name: "bash" }, messages: [{ role: "user", content: "Hi" }] }, "gpt-5.6-luna") as any;
  assert.deepEqual(forced.tool_choice, { type: "function", name: "bash" });
});

test("flags a failed or truly incomplete Responses result but not a length-limited one", () => {
  assert.match(responsesResponseFailure({ status: "failed", error: { message: "boom" } }) ?? "", /boom/);
  assert.match(responsesResponseFailure({ status: "incomplete", incomplete_details: { reason: "content_filter" } }) ?? "", /content_filter/);
  assert.equal(responsesResponseFailure({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), undefined);
  assert.equal(responsesResponseFailure({ status: "completed" }), undefined);
});

// --- Responses <-> Anthropic (custom providers whose upstream speaks native Anthropic Messages API) ---

test("converts a basic Responses request to an Anthropic request", () => {
  const result = toAnthropicRequest({ instructions: "Be concise", input: "Hi", max_output_tokens: 10 }, "claude-x") as any;
  assert.deepEqual(result, { model: "claude-x", messages: [{ role: "user", content: "Hi" }], max_tokens: 10, system: "Be concise" });
});

test("defaults max_tokens when the Responses request omits max_output_tokens (Anthropic requires it)", () => {
  const result = toAnthropicRequest({ input: "Hi" }, "claude-x") as any;
  assert.equal(result.max_tokens, 4096);
});

test("converts Responses tools and tool_choice to Anthropic shape", () => {
  const result = toAnthropicRequest({
    input: "Hi",
    tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "bash" },
  }, "claude-x") as any;
  assert.deepEqual(result.tools, [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }]);
  assert.deepEqual(result.tool_choice, { type: "tool", name: "bash" });
});

test("maps Responses reasoning.effort to Anthropic thinking with a token budget", () => {
  assert.deepEqual((toAnthropicRequest({ input: "Hi", reasoning: { effort: "none" } }, "claude-x") as any).thinking, { type: "disabled" });
  // With the default max_tokens of 4096 the tiered budget is capped below it —
  // Anthropic rejects max_tokens <= thinking.budget_tokens.
  assert.deepEqual((toAnthropicRequest({ input: "Hi", reasoning: { effort: "high" } }, "claude-x") as any).thinking, { type: "enabled", budget_tokens: 3276 });
  assert.equal((toAnthropicRequest({ input: "Hi" }, "claude-x") as any).thinking, undefined);
});

test("caps the thinking budget under an explicit max_output_tokens and drops thinking when too small", () => {
  const capped = toAnthropicRequest({ input: "Hi", max_output_tokens: 20000, reasoning: { effort: "high" } }, "claude-x") as any;
  assert.deepEqual(capped.thinking, { type: "enabled", budget_tokens: 16000 });
  assert.equal(capped.max_tokens, 20000);
  // max_tokens=1000 leaves no room for a >=1024 budget, so thinking is dropped
  // instead of letting the upstream reject the whole request.
  const dropped = toAnthropicRequest({ input: "Hi", max_output_tokens: 1000, reasoning: { effort: "high" } }, "claude-x") as any;
  assert.equal(dropped.thinking, undefined);
  assert.equal(dropped.max_tokens, 1000);
});

test("merges a Responses turn's separate function_call items back into one Anthropic assistant message", () => {
  const result = toAnthropicRequest({
    input: [
      { role: "user", content: "run ls" },
      { role: "assistant", content: [{ type: "output_text", text: "Sure," }] },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "file.txt" },
      { role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    ],
  }, "claude-x") as any;
  assert.deepEqual(result.messages, [
    { role: "user", content: "run ls" },
    { role: "assistant", content: [{ type: "text", text: "Sure," }, { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ]);
});

test("drops reasoning items from a Responses request (no signature to echo upstream)", () => {
  const result = toAnthropicRequest({ input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "thinking…" }] }, { role: "user", content: "go" }] }, "claude-x") as any;
  assert.deepEqual(result.messages, [{ role: "user", content: "go" }]);
});

test("converts an Anthropic response's content blocks to Responses output items", () => {
  const result = fromAnthropicResponse({
    id: "msg_1",
    content: [{ type: "thinking", thinking: "let me think" }, { type: "text", text: "OK" }, { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 50, output_tokens: 9, cache_read_input_tokens: 40 },
  }, "claude-x") as any;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output[0], { type: "reasoning", id: result.output[0].id, summary: [{ type: "summary_text", text: "let me think" }] });
  assert.deepEqual(result.output[1], { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] });
  assert.deepEqual(result.output[2], { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}', status: "completed" });
  assert.equal(result.usage.input_tokens, 50);
  assert.equal(result.usage.output_tokens, 9);
  assert.deepEqual(result.usage.input_tokens_details, { cached_tokens: 40 });
});

test("marks an Anthropic response incomplete when stop_reason is max_tokens", () => {
  const result = fromAnthropicResponse({ id: "msg_1", content: [{ type: "text", text: "cut off" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } }, "claude-x") as any;
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.incomplete_details, { reason: "max_output_tokens" });
});

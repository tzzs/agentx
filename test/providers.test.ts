import test from "node:test";
import assert from "node:assert/strict";
import { chatThinking, chatToolChoice, fromResponsesResponse, reasoningEffort, responsesResponseFailure, responsesToolChoice, toResponsesRequest } from "../src/providers.js";

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

import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicThinking, anthropicToolChoice, chatControlParams, chatThinking, chatToolChoice,
  collapseAnthropicContent, imageDataUri, reasoningEffort, responsesToolChoice, samplingParams,
  textOfBlocks, toAnthropicImageSource,
} from "../src/convert/shared.js";

test("collapseAnthropicContent joins pure-text blocks and keeps mixed arrays as blocks", () => {
  assert.equal(collapseAnthropicContent([]), "");
  assert.equal(collapseAnthropicContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  // A text-only block with no text still counts as text: it joins as "".
  assert.equal(collapseAnthropicContent([{ type: "text" }]), "");
  assert.deepEqual(collapseAnthropicContent([{ type: "text", text: "a" }, { type: "image" }]), [{ type: "text", text: "a" }, { type: "image" }]);
});

test("textOfBlocks reads one block type and ignores the rest", () => {
  const content = [{ type: "text", text: "hello" }, { type: "thinking", thinking: "hm" }, { type: "tool_use", id: "t1" }];
  assert.equal(textOfBlocks(content, "text"), "hello");
  assert.equal(textOfBlocks(content, "thinking"), "hm");
  assert.equal(textOfBlocks([], "text"), "");
  assert.equal(textOfBlocks([{ type: "text" }], "text"), "");
});

test("imageDataUri builds a data URI, passes a remote URL through, and drops what it cannot represent", () => {
  assert.equal(imageDataUri({ type: "url", url: "https://x/y.png" }), "https://x/y.png");
  assert.equal(imageDataUri({ type: "base64", media_type: "image/jpeg", data: "AA" }), "data:image/jpeg;base64,AA");
  assert.equal(imageDataUri({ type: "base64", data: "AA" }), "data:image/png;base64,AA");
  assert.equal(imageDataUri({ type: "base64" }), undefined);
  assert.equal(imageDataUri({ type: "file", path: "/x" }), undefined);
  assert.equal(imageDataUri(undefined), undefined);
});

test("toAnthropicImageSource reads a data URI into base64 and leaves other URLs as url sources", () => {
  assert.equal(toAnthropicImageSource(undefined), undefined);
  assert.equal(toAnthropicImageSource(""), undefined);
  assert.deepEqual(toAnthropicImageSource("https://x/y.png"), { type: "url", url: "https://x/y.png" });
  assert.deepEqual(toAnthropicImageSource("data:image/gif;base64,R0lG"), { type: "base64", media_type: "image/gif", data: "R0lG" });
});

test("reasoningEffort collapses vendor effort names onto the Chat Completions scale", () => {
  for (const value of ["minimal", "low"]) assert.equal(reasoningEffort({ reasoning: { effort: value } }), "low");
  for (const value of ["medium", "high", "xhigh", "ultracode"]) assert.equal(reasoningEffort({ reasoning: { effort: value } }), "high");
  for (const value of ["max", "ultra"]) assert.equal(reasoningEffort({ reasoning: { effort: value } }), "max");
  assert.equal(reasoningEffort({ reasoning: { effort: "telepathic" } }), undefined);
  assert.equal(reasoningEffort({ reasoning: { effort: 5 } }), undefined);
  assert.equal(reasoningEffort(undefined), undefined);
  // output_config wins over reasoning when both are present.
  assert.equal(reasoningEffort({ output_config: { effort: "max" }, reasoning: { effort: "low" } }), "max");
});

test("chatThinking maps Anthropic thinking controls and effort names, and stays absent otherwise", () => {
  assert.deepEqual(chatThinking({ thinking: { type: "disabled" } }), { type: "disabled" });
  assert.deepEqual(chatThinking({ thinking: { type: "enabled" } }), { type: "enabled" });
  assert.deepEqual(chatThinking({ thinking: { type: "adaptive" } }), { type: "enabled" });
  assert.deepEqual(chatThinking({ reasoning: { effort: "none" } }), { type: "disabled" });
  assert.deepEqual(chatThinking({ reasoning: { effort: "high" } }), { type: "enabled" });
  assert.equal(chatThinking({ thinking: { type: "sometimes" } }), undefined);
  assert.equal(chatThinking({}), undefined);
  assert.equal(chatThinking(undefined), undefined);
});

test("tool choice converts to each dialect, including both names of a forced tool", () => {
  // The two upstream dialects name a forced tool differently: Responses puts
  // `name` on the choice, Chat Completions nests it under `function`.
  for (const choice of [{ type: "function", name: "bash" }, { type: "function", function: { name: "bash" } }] as const) {
    assert.deepEqual(chatToolChoice(choice), { type: "function", function: { name: "bash" } });
    assert.deepEqual(responsesToolChoice(choice), { type: "function", name: "bash" });
    assert.deepEqual(anthropicToolChoice(choice), { type: "tool", name: "bash" });
  }
  assert.equal(chatToolChoice("required"), "required");
  assert.equal(responsesToolChoice("any"), "required");
  assert.deepEqual(anthropicToolChoice("required"), { type: "any" });
  assert.deepEqual(anthropicToolChoice("auto"), { type: "auto" });
  // A forced tool with no name is not a choice we can forward, and Anthropic's
  // own `{type:"tool"}` shape is not one of the source dialects.
  assert.equal(chatToolChoice({ type: "function" }), undefined);
  assert.equal(anthropicToolChoice({ type: "function", name: 7 }), undefined);
  assert.equal(anthropicToolChoice({ type: "tool", name: "bash" }), undefined);
  assert.equal(anthropicToolChoice("gpt-4o"), undefined);
  assert.equal(chatToolChoice(42), undefined);
  assert.equal(responsesToolChoice(null), undefined);
});

test("samplingParams forwards only the knobs the client set", () => {
  assert.deepEqual(samplingParams({}), {});
  assert.deepEqual(samplingParams({ temperature: 0, top_p: 1, stop_sequences: ["\n"] }), { temperature: 0, top_p: 1, stop: ["\n"] });
  // An explicit null is a value, not an absent knob.
  assert.deepEqual(samplingParams({ temperature: null }), { temperature: null });
});

test("chatControlParams gates DeepSeek-only controls behind the provider check", () => {
  const input = { thinking: { type: "enabled" }, reasoning: { effort: "high" }, tool_choice: "required" };
  assert.deepEqual(chatControlParams(input, true), { thinking: { type: "enabled" }, reasoning_effort: "high", tool_choice: "required" });
  assert.deepEqual(chatControlParams(input, false), { tool_choice: "required" });
  assert.deepEqual(chatControlParams({}, false), {});
});

test("anthropicThinking gives each effort a concrete budget, and nothing an unknown one", () => {
  assert.deepEqual(anthropicThinking("none"), { type: "disabled" });
  assert.deepEqual(anthropicThinking("minimal"), { type: "enabled", budget_tokens: 1024 });
  assert.deepEqual(anthropicThinking("low"), { type: "enabled", budget_tokens: 4096 });
  assert.deepEqual(anthropicThinking("high"), { type: "enabled", budget_tokens: 16000 });
  assert.deepEqual(anthropicThinking("max"), { type: "enabled", budget_tokens: 32000 });
  assert.equal(anthropicThinking("sometimes"), undefined);
  assert.equal(anthropicThinking(undefined), undefined);
  assert.equal(anthropicThinking(3), undefined);
});

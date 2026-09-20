import test from "node:test";
import assert from "node:assert/strict";
import { fromChatResponse, fromResponsesResponse, toChatRequest, toResponsesRequest } from "../src/convert/index.js";

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

// --- tool results carrying media -------------------------------------------
// Anthropic allows a tool_result's content to be a block array (Claude Code's
// Read tool returns one for an image). Serializing that array as JSON used to
// send the image's base64 upstream as literal text.

const imageResult = {
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: { path: "/a.png" } }] },
    {
      role: "user",
      content: [{
        type: "tool_result", tool_use_id: "call-1",
        content: [{ type: "text", text: "read ok" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
      }],
    },
  ],
};

test("inlines tool-result media as Responses input_image parts instead of a JSON string", () => {
  const input = toResponsesRequest(imageResult as any, "gpt-5.6-luna").input as any[];
  assert.deepEqual(input[1], {
    type: "function_call_output",
    call_id: "call-1",
    output: [{ type: "input_text", text: "read ok" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }],
  });
});

test("drops tool-result media for a Responses model known not to accept images", () => {
  const provider = { provider: "opencode", model: "text-only", protocol: "responses", endpoint: "https://upstream.invalid/responses", modalities: ["text"] } as const;
  const input = toResponsesRequest(imageResult as any, "text-only", provider as any).input as any[];
  assert.deepEqual(input[1], {
    type: "function_call_output",
    call_id: "call-1",
    output: "read ok\n[1 image returned by the tool; omitted because this model does not accept image input]",
  });
});

test("lifts tool-result media into a following user message for chat completions", () => {
  const messages = (toChatRequest(imageResult as any, "glm-5") as any).messages;
  // The tool message itself must stay a plain string: chat completions has no
  // other shape for it.
  assert.deepEqual(messages[1], { role: "tool", tool_call_id: "call-1", content: "read ok" });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [{ type: "text", text: "Attached media from tool result:" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
  });
});

test("keeps a media-only tool result non-empty and says so when the image cannot be forwarded", () => {
  const mediaOnly = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] },
    ],
  };
  const forwarded = (toChatRequest(mediaOnly as any, "glm-5") as any).messages;
  assert.equal(forwarded[1].content, "[1 image returned by the tool]");
  const provider = { provider: "opencode", model: "text-only", protocol: "chat-completions", endpoint: "https://upstream.invalid/chat/completions", modalities: ["text"] };
  const dropped = (toChatRequest(mediaOnly as any, "text-only", provider as any) as any).messages;
  assert.match(dropped[1].content, /omitted because this model does not accept image input/);
  assert.equal(dropped.length, 2); // no synthetic user message
});

test("announces a dropped image even when the tool result had text of its own", () => {
  const provider = { provider: "opencode", model: "text-only", protocol: "chat-completions", endpoint: "https://upstream.invalid/chat/completions", modalities: ["text"] };
  const messages = (toChatRequest(imageResult as any, "text-only", provider as any) as any).messages;
  // The text alone would leave the model silently missing content it was
  // never told about.
  assert.equal(messages[1].content, "read ok\n[1 image returned by the tool; omitted because this model does not accept image input]");
  assert.equal(messages.length, 2);
  const responses = toResponsesRequest(imageResult as any, "text-only", provider as any).input as any[];
  assert.match(String(responses[1].output), /omitted because this model does not accept image input/);
});

test("flattens a text-only tool_result block array instead of forwarding its JSON", () => {
  const blocks = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] }] },
    ],
  };
  assert.equal((toChatRequest(blocks as any, "glm-5") as any).messages[1].content, "line one\nline two");
});

test("maps an unrecognized finish_reason to end_turn rather than max_tokens", () => {
  const ended = fromChatResponse({ choices: [{ message: { content: "hi" }, finish_reason: "something_new" }] }, "glm-5") as any;
  assert.equal(ended.stop_reason, "end_turn");
  const filtered = fromChatResponse({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }, "glm-5") as any;
  assert.equal(filtered.stop_reason, "refusal");
  const truncated = fromChatResponse({ choices: [{ message: { content: "hi" }, finish_reason: "length" }] }, "glm-5") as any;
  assert.equal(truncated.stop_reason, "max_tokens");
});

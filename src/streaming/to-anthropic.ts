import type { ServerResponse } from "node:http";
import { chatResponseFailure } from "../convert/index.js";
import { cacheTokensOf, cancelOnDisconnect, drain, errorMessage, event, failureMessage, reasoningDeltaOf, reportUsage, SSE_HEADERS, startHeartbeat, UpstreamFailure, type StreamUsageOptions } from "./common.js";

/**
 * Translate a Responses or Chat Completions SSE stream into Anthropic message
 * events. Used for Claude Code, regardless of which upstream protocol the
 * provider actually speaks.
 */
export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  // try/finally guarantees the interval is cleared even if a write to the
  // local client throws before the main try block is entered.
  const stopHeartbeat = startHeartbeat(response);
  try {
  const id = `msg_${crypto.randomUUID()}`;
  event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  let outputTokens = 0; let inputTokens = 0; let sawUsage = false; let blockIndex = 0; let blockStarted = false; let blockType: "text" | "tool_use" | "thinking" | undefined; let toolStop = false; let truncated = false; let lastUsage: any;
  // A chat-completions-shaped upstream (unlike a native Responses one) must
  // close every turn with either a finish_reason or [DONE]; seeing neither
  // means the connection dropped mid-turn and must not read back as end_turn.
  let sawChatShape = false; let sawFinishReason = false; let sawDone = false;
  // Parallel tool calls arrive interleaved and keyed by chat `index` or
  // Responses `item_id`; each key gets its own Anthropic content block.
  const calls = new Map<string | number, { id: string; name: string }>();
  let activeTool: string | number | null = null;
  const stopBlock = () => { if (blockStarted) { event(response, "content_block_stop", { type: "content_block_stop", index: blockIndex }); blockStarted = false; blockType = undefined; blockIndex++; activeTool = null; } };
  const startText = () => {
    // Text after a tool call or thinking must not append to that block.
    if (!blockStarted || blockType !== "text") {
      stopBlock();
      event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
      blockStarted = true; blockType = "text";
    }
  };
  const startThinking = () => {
    if (!blockStarted || blockType !== "thinking") {
      stopBlock();
      event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "" } });
      blockStarted = true; blockType = "thinking";
    }
  };
  const startTool = (id: string, name: string) => { stopBlock(); event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name, input: {} } }); blockStarted = true; blockType = "tool_use"; toolStop = true; };
  /** Switch to the block of another tool call when the stream jumps between them. */
  const openTool = (key: string | number, id: string, name: string) => {
    if (activeTool === key && blockStarted && blockType === "tool_use") return;
    startTool(id, name);
    activeTool = key;
  };
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim(); if (!value) return;
    if (value === "[DONE]") { sawDone = true; return; }
    try {
      const item = JSON.parse(value);
      const failure = failureMessage(item);
      if (failure) throw new UpstreamFailure(failure);
      const choice = item.choices?.[0];
      if (Array.isArray(item.choices)) {
        sawChatShape = true;
        if (choice?.finish_reason != null) {
          sawFinishReason = true;
          const chatFailure = chatResponseFailure(item);
          if (chatFailure) { options?.onDiagnostic?.(`chat completions finish_reason=${choice.finish_reason}: ${chatFailure}`); throw new UpstreamFailure(chatFailure); }
        }
      }
      if (choice?.finish_reason === "length") truncated = true;
      const reasoning = reasoningDeltaOf(item);
      if (typeof reasoning === "string") { startThinking(); event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: reasoning } }); }
      const text = item.type === "response.output_text.delta"
        ? item.delta
        : choice?.delta?.content;
      if (typeof text === "string" && text) { startText(); outputTokens++; event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } }); }
      const itemTool = item.type === "response.output_item.added" && item.item?.type === "function_call" ? item.item : undefined;
      const responseArgs = item.type === "response.function_call_arguments.delta" ? item.delta : undefined;
      for (const tool of choice?.delta?.tool_calls ?? []) {
        const key = tool.index ?? 0;
        const call = calls.get(key) ?? { id: tool.id ?? `call_${key}`, name: "" };
        if (tool.id) call.id = tool.id;
        if (tool.function?.name) call.name = tool.function.name;
        calls.set(key, call);
        openTool(key, call.id, call.name);
        if (tool.function?.arguments) event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: tool.function.arguments } });
      }
      if (itemTool) {
        const key = itemTool.call_id ?? itemTool.id ?? `call_${blockIndex}`;
        calls.set(key, { id: key, name: itemTool.name ?? "" });
        openTool(key, key, itemTool.name ?? "");
      }
      if (typeof responseArgs === "string") {
        const key = item.call_id ?? item.item_id ?? activeTool ?? "";
        const known = calls.get(key);
        openTool(key, key, item.name ?? known?.name ?? "");
        event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: responseArgs } });
      }
      if (item.response?.usage) { inputTokens = item.response.usage.input_tokens ?? inputTokens; outputTokens = item.response.usage.output_tokens ?? outputTokens; lastUsage = item.response.usage; sawUsage = true; }
      if (item.usage) { inputTokens = item.usage.prompt_tokens ?? inputTokens; outputTokens = item.usage.completion_tokens ?? outputTokens; lastUsage = item.usage; sawUsage = true; }
    } catch (error) {
      // In-band upstream failures must end the stream; only parse noise is ignored.
      if (error instanceof UpstreamFailure) throw error;
    }
  };
  try {
    await drain(reader, consume);
    if (sawChatShape && !sawFinishReason && !sawDone) {
      const message = "Upstream chat completions stream ended before a finish_reason or [DONE] was received.";
      options?.onDiagnostic?.(message);
      throw new UpstreamFailure(message);
    }
    if (!blockStarted) startText();
    stopBlock();
    const stopReason = truncated ? "max_tokens" : toolStop ? "tool_use" : "end_turn";
    const { cached } = cacheTokensOf(lastUsage);
    event(response, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: cached ?? 0 } });
    event(response, "message_stop", { type: "message_stop" });
  } catch (error) {
    // Match Anthropic semantics: a terminal error event closes the stream.
    stopBlock();
    event(response, "error", { type: "error", error: { type: "api_error", message: errorMessage(error) } });
  }
  response.end();
  reportUsage(options, sawUsage, inputTokens, outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

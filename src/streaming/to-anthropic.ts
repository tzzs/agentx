import type { ServerResponse } from "node:http";
import { chatResponseFailure } from "../convert/index.js";
import { jsonRecord, recNum, recObj, recObjs, recStr } from "../json.js";
import {
  cacheTokensOf, dataLine, drain, emitAnthropicError, event, failureMessage, newUsageCapture, reasoningDeltaOf,
  reportUsage, usageCapture, withSsePipe, UpstreamFailure, type StreamUsageOptions,
} from "./common.js";

/**
 * Translate a Responses or Chat Completions SSE stream into Anthropic message
 * events. Used for Claude Code, regardless of which upstream protocol the
 * provider actually speaks.
 */
export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const id = `msg_${crypto.randomUUID()}`;
    event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    const capture = newUsageCapture();
    // This pipe serves whichever non-Anthropic upstream protocol is actually
    // configured, and the payload itself reveals the shape: usage arriving on
    // `item.usage` is chat-shaped, on `item.response.usage` Responses-shaped.
    const chat = usageCapture(capture, "chat-completions");
    const responses = usageCapture(capture, "responses");
    let blockIndex = 0; let blockStarted = false; let blockType: "text" | "tool_use" | "thinking" | undefined; let toolStop = false; let truncated = false;
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
      const value = dataLine(line);
      if (!value) return;
      if (value === "[DONE]") { sawDone = true; return; }
      try {
        const item = jsonRecord(JSON.parse(value));
        const failure = failureMessage(item);
        if (failure) throw new UpstreamFailure(failure);
        const choice = recObjs(item, "choices")[0];
        const delta = recObj(choice, "delta");
        const finishReason = recStr(choice, "finish_reason");
        if (Array.isArray(item.choices)) {
          sawChatShape = true;
          if (finishReason !== undefined) {
            sawFinishReason = true;
            const chatFailure = chatResponseFailure(item);
            if (chatFailure) { options?.onDiagnostic?.(`chat completions finish_reason=${finishReason}: ${chatFailure}`); throw new UpstreamFailure(chatFailure); }
          }
        }
        if (finishReason === "length") truncated = true;
        const reasoning = reasoningDeltaOf(item);
        if (reasoning) { startThinking(); event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: reasoning } }); }
        const text = item.type === "response.output_text.delta" ? recStr(item, "delta") : recStr(delta, "content");
        if (text) { startText(); capture.output++; event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } }); }
        const addedItem = recObj(item, "item");
        const itemTool = item.type === "response.output_item.added" && addedItem?.type === "function_call" ? addedItem : undefined;
        const responseArgs = item.type === "response.function_call_arguments.delta" ? recStr(item, "delta") : undefined;
        for (const tool of recObjs(delta, "tool_calls")) {
          const key = recNum(tool, "index") ?? 0;
          const call = calls.get(key) ?? { id: recStr(tool, "id") ?? `call_${key}`, name: "" };
          const toolId = recStr(tool, "id");
          if (toolId) call.id = toolId;
          const toolFunction = recObj(tool, "function");
          const toolName = recStr(toolFunction, "name");
          if (toolName) call.name = toolName;
          calls.set(key, call);
          openTool(key, call.id, call.name);
          const partialJson = recStr(toolFunction, "arguments");
          if (partialJson) event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: partialJson } });
        }
        if (itemTool) {
          const key = recStr(itemTool, "call_id") ?? recStr(itemTool, "id") ?? `call_${blockIndex}`;
          const name = recStr(itemTool, "name") ?? "";
          calls.set(key, { id: key, name });
          openTool(key, key, name);
        }
        if (responseArgs) {
          const key = recStr(item, "call_id") ?? recStr(item, "item_id") ?? activeTool ?? "";
          const known = calls.get(key);
          // Anthropic tool-use ids are strings; a Responses event that carries
          // none falls back to a numeric chat index, which must not leak through.
          openTool(key, String(key), recStr(item, "name") ?? known?.name ?? "");
          event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: responseArgs } });
        }
        const responseUsage = recObj(recObj(item, "response"), "usage");
        if (responseUsage) responses.usage(responseUsage);
        const itemUsage = recObj(item, "usage");
        if (itemUsage) chat.usage(itemUsage);
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
      const { cached } = cacheTokensOf(capture.raw);
      event(response, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: capture.output, input_tokens: capture.input, cache_creation_input_tokens: 0, cache_read_input_tokens: cached ?? 0 } });
      event(response, "message_stop", { type: "message_stop" });
    } catch (error) {
      // Match Anthropic semantics: a terminal error event closes the stream.
      stopBlock();
      emitAnthropicError(response, error);
    }
    response.end();
    reportUsage(options, capture);
  });
}

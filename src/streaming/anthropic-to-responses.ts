import type { ServerResponse } from "node:http";
import {
  announceMessageItem, announceReasoning, dataLine, drain, emitFunctionCallDelta, emitReasoningDelta,
  emitResponsesCompleted, emitResponsesError, emitTextDelta, event, failureMessage,
  newUsageCapture, reportUsage, usageCapture, withSsePipe, UpstreamFailure,
  type ReasoningState, type StreamUsageOptions,
} from "./common.js";

/**
 * Pipe a native Anthropic Messages SSE stream into Codex-style Responses
 * events. Used for Codex (or any other Responses-facing client) reaching a
 * custom provider whose protocol is "anthropic" — mirrors
 * `pipeChatStreamToResponses`'s role for a Chat Completions upstream, just
 * parsing Anthropic's `content_block_*`/`message_*` event grammar instead.
 * Anthropic's content block `index` is reused directly as the Responses
 * `output_index` for tool calls, since Anthropic already hands out stable
 * per-block indices.
 */
export async function pipeAnthropicStreamToResponses(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const id = `resp_${crypto.randomUUID()}`; const msgId = `msg_${crypto.randomUUID()}`;
    const capture = newUsageCapture();
    const usage = usageCapture(capture, "anthropic");
    let text = ""; let truncated = false;
    const messageAnnounced = { done: false };
    const reasoning: ReasoningState = { id: "", text: "" };
    // A native Anthropic upstream must close every turn with message_stop;
    // seeing neither it nor an in-band error means the connection dropped
    // mid-turn and must not read back as a normal "completed" response.
    let sawMessageStop = false;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    event(response, "response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [] } });
    const consume = (line: string) => {
      const value = dataLine(line);
      if (!value) return;
      try {
        const item = JSON.parse(value);
        const failure = failureMessage(item);
        if (failure) throw new UpstreamFailure(failure);
        if (item.type === "message_start" && item.message?.usage) usage.usage(item.message.usage);
        if (item.type === "content_block_start") {
          const blockType = item.content_block?.type;
          if (blockType === "tool_use") {
            const call = { id: item.content_block.id ?? `call_${item.index}`, name: item.content_block.name ?? "", arguments: "" };
            calls.set(item.index, call);
            event(response, "response.output_item.added", { type: "response.output_item.added", output_index: item.index, item: { type: "function_call", id: `fc_${item.index}`, call_id: call.id, name: call.name, arguments: "", status: "in_progress" } });
          } else if (blockType === "thinking") {
            announceReasoning(response, reasoning);
          }
        }
        if (item.type === "content_block_delta") {
          const delta = item.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            announceMessageItem(response, msgId, messageAnnounced);
            text += delta.text; capture.output++;
            emitTextDelta(response, msgId, delta.text);
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            emitReasoningDelta(response, reasoning, delta.thinking);
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const call = calls.get(item.index);
            if (call) {
              call.arguments += delta.partial_json;
              emitFunctionCallDelta(response, { itemId: `fc_${item.index}`, outputIndex: item.index, callId: call.id, delta: delta.partial_json });
            }
          }
        }
        if (item.type === "message_delta") {
          if (item.delta?.stop_reason === "max_tokens") truncated = true;
          if (item.usage) usage.usage(item.usage);
        }
        if (item.type === "message_stop") sawMessageStop = true;
      } catch (error) {
        // In-band upstream failures must end the stream; only parse noise is ignored.
        if (error instanceof UpstreamFailure) throw error;
      }
    };
    try {
      await drain(reader, consume);
      if (!sawMessageStop) {
        const message = "Upstream Anthropic stream ended before message_stop was received.";
        options?.onDiagnostic?.(message);
        throw new UpstreamFailure(message);
      }
      emitResponsesCompleted(response, { id, model, capture, truncated, text, msgId, reasoning, calls });
    } catch (error) {
      emitResponsesError(response, id, model, error);
    }
    response.end();
    reportUsage(options, capture);
  });
}

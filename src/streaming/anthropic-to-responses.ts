import type { ServerResponse } from "node:http";
import {
  announceMessageItem, announceReasoning, dataLine, drain, emitFunctionCallDelta, emitReasoningDelta,
  emitResponsesCompleted, emitResponsesError, emitTextDelta, event, failureMessage,
  newUsageCapture, reportUsage, usageCapture, withSsePipe, UpstreamFailure,
  type ReasoningState, type StreamUsageOptions,
} from "./common.js";
import { jsonRecord, recNum, recObj, recStr } from "../json.js";

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
        const item = jsonRecord(JSON.parse(value));
        const failure = failureMessage(item);
        if (failure) throw new UpstreamFailure(failure);
        const startUsage = recObj(recObj(item, "message"), "usage");
        if (item.type === "message_start" && startUsage) usage.usage(startUsage);
        const index = recNum(item, "index") ?? 0;
        const contentBlock = recObj(item, "content_block");
        if (item.type === "content_block_start") {
          const blockType = recStr(contentBlock, "type");
          if (blockType === "tool_use") {
            const call = { id: recStr(contentBlock, "id") ?? `call_${index}`, name: recStr(contentBlock, "name") ?? "", arguments: "" };
            calls.set(index, call);
            event(response, "response.output_item.added", { type: "response.output_item.added", output_index: index, item: { type: "function_call", id: `fc_${index}`, call_id: call.id, name: call.name, arguments: "", status: "in_progress" } });
          } else if (blockType === "thinking") {
            announceReasoning(response, reasoning);
          }
        }
        const delta = recObj(item, "delta");
        if (item.type === "content_block_delta") {
          const deltaType = recStr(delta, "type");
          const textDelta = recStr(delta, "text");
          const thinkingDelta = recStr(delta, "thinking");
          const partialJson = recStr(delta, "partial_json");
          if (deltaType === "text_delta" && textDelta !== undefined) {
            announceMessageItem(response, msgId, messageAnnounced);
            text += textDelta; capture.output++;
            emitTextDelta(response, msgId, textDelta);
          } else if (deltaType === "thinking_delta" && thinkingDelta !== undefined) {
            emitReasoningDelta(response, reasoning, thinkingDelta);
          } else if (deltaType === "input_json_delta" && partialJson !== undefined) {
            const call = calls.get(index);
            if (call) {
              call.arguments += partialJson;
              emitFunctionCallDelta(response, { itemId: `fc_${index}`, outputIndex: index, callId: call.id, delta: partialJson });
            }
          }
        }
        if (item.type === "message_delta") {
          if (recStr(recObj(item, "delta"), "stop_reason") === "max_tokens") truncated = true;
          const deltaUsage = recObj(item, "usage");
          if (deltaUsage) usage.usage(deltaUsage);
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

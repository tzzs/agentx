import type { ServerResponse } from "node:http";
import {
  createChatEmitter, dataLine, drain, emitChatError, emitChatToolDelta,
  failureMessage, newUsageCapture, reportUsage, usageCapture, withSsePipe, UpstreamFailure,
  type ChatToolCallState, type StreamUsageOptions,
} from "./common.js";
import { jsonRecord, recNum, recObj, recStr } from "../json.js";

/**
 * Pipe a native Anthropic Messages SSE stream into OpenAI-style
 * `chat.completion.chunk` events. Used for a Chat-Completions-facing client
 * (the local `/v1/chat/completions` endpoint) reaching a custom provider
 * whose protocol is "anthropic" — mirrors `pipeAnthropicStreamToResponses`'s
 * role for the Responses-facing endpoint, but chat.completion.chunk deltas
 * are emitted live rather than buffered into a final synthesized response,
 * since the chunk grammar has no announce/done event pair to satisfy.
 */
export async function pipeAnthropicStreamToChat(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const capture = newUsageCapture();
    const usage = usageCapture(capture, "anthropic");
    let truncated = false;
    // A native Anthropic upstream must close with message_stop; seeing
    // neither it nor an in-band error means the connection dropped mid-turn.
    let sawMessageStop = false;
    const calls = new Map<number, ChatToolCallState>();
    const chunk = createChatEmitter(response, model);
    const consume = (line: string) => {
      const value = dataLine(line);
      if (!value) return;
      try {
        const item = jsonRecord(JSON.parse(value));
        const failure = failureMessage(item);
        if (failure) throw new UpstreamFailure(failure);
        const index = recNum(item, "index") ?? 0;
        const startUsage = recObj(recObj(item, "message"), "usage");
        if (item.type === "message_start" && startUsage) usage.usage(startUsage);
        const contentBlock = recObj(item, "content_block");
        if (item.type === "content_block_start" && contentBlock?.type === "tool_use") {
          calls.set(index, { id: recStr(contentBlock, "id") ?? `call_${index}`, name: recStr(contentBlock, "name") ?? "", announced: false });
        }
        const delta = recObj(item, "delta");
        if (item.type === "content_block_delta") {
          const deltaType = recStr(delta, "type");
          const text = recStr(delta, "text");
          const thinking = recStr(delta, "thinking");
          const partialJson = recStr(delta, "partial_json");
          if (deltaType === "text_delta" && text !== undefined) { capture.output++; chunk({ content: text }); }
          else if (deltaType === "thinking_delta" && thinking !== undefined) { chunk({ reasoning_content: thinking }); }
          else if (deltaType === "input_json_delta" && partialJson !== undefined) {
            const call = calls.get(index);
            if (call) emitChatToolDelta(chunk, call, index, partialJson);
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
      chunk({}, calls.size ? "tool_calls" : truncated ? "length" : "stop");
      response.write("data: [DONE]\n\n");
    } catch (error) {
      emitChatError(response, chunk, error);
    }
    response.end();
    reportUsage(options, capture);
  });
}

import type { ServerResponse } from "node:http";
import {
  createChatEmitter, dataLine, drain, emitAnthropicError, emitChatError, emitChatToolDelta,
  failureMessage, newUsageCapture, reportUsage, usageCapture, withSsePipe, UpstreamFailure,
  type ChatToolCallState, type StreamUsageOptions,
} from "./common.js";

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
        const item = JSON.parse(value);
        const failure = failureMessage(item);
        if (failure) throw new UpstreamFailure(failure);
        if (item.type === "message_start" && item.message?.usage) usage.usage(item.message.usage);
        if (item.type === "content_block_start" && item.content_block?.type === "tool_use") {
          calls.set(item.index, { id: item.content_block.id ?? `call_${item.index}`, name: item.content_block.name ?? "", announced: false });
        }
        if (item.type === "content_block_delta") {
          const delta = item.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string") { capture.output++; chunk({ content: delta.text }); }
          else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") { chunk({ reasoning_content: delta.thinking }); }
          else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const call = calls.get(item.index);
            if (call) emitChatToolDelta(chunk, call, item.index, delta.partial_json);
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
      chunk({}, calls.size ? "tool_calls" : truncated ? "length" : "stop");
      response.write("data: [DONE]\n\n");
    } catch (error) {
      emitChatError(response, chunk, error);
    }
    response.end();
    reportUsage(options, capture);
  });
}

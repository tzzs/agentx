import type { ServerResponse } from "node:http";
import {
  createChatEmitter, dataLine, drain, emitChatError, emitChatToolDelta, failureMessage,
  newUsageCapture, reasoningDeltaOf, reportUsage, usageCapture, withSsePipe, UpstreamFailure,
  type ChatToolCallState, type StreamUsageOptions,
} from "./common.js";

/**
 * Pipe a native Responses SSE stream into OpenAI-style `chat.completion.chunk`
 * events. Used for a Chat-Completions-facing client (the local
 * `/v1/chat/completions` endpoint) reaching a custom provider whose protocol
 * is "responses" — the mirror of `pipeChatStreamToResponses`, translating the
 * other direction. Only genuine Responses-shaped events are expected here
 * (unlike `pipeResponsesStream`, which also has to sniff a chat-completions
 * upstream shape): this pipe is only ever selected for `protocol === "responses"`.
 */
export async function pipeResponsesStreamToChat(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const capture = newUsageCapture();
    const usage = usageCapture(capture, "responses");
    let truncated = false; let sawCompleted = false;
    const calls = new Map<string, ChatToolCallState & { index: number }>();
    const chunk = createChatEmitter(response, model);
    const consume = (line: string) => {
      const value = dataLine(line);
      if (!value) return;
      try {
        const item = JSON.parse(value);
        const failure = failureMessage(item);
        if (failure) throw new UpstreamFailure(failure);
        if (item.type === "response.output_text.delta" && typeof item.delta === "string") { capture.output++; chunk({ content: item.delta }); }
        const reasoning = reasoningDeltaOf(item);
        if (typeof reasoning === "string") chunk({ reasoning_content: reasoning });
        if (item.type === "response.output_item.added" && item.item?.type === "function_call") {
          const key = item.item.call_id ?? item.item.id ?? `call_${calls.size}`;
          calls.set(key, { index: calls.size, id: key, name: item.item.name ?? "", announced: false });
        }
        if (item.type === "response.function_call_arguments.delta" && typeof item.delta === "string") {
          const key = item.call_id ?? item.item_id ?? "";
          const call = calls.get(key) ?? { index: calls.size, id: key, name: item.name ?? "", announced: false };
          calls.set(key, call);
          emitChatToolDelta(chunk, call, call.index, item.delta);
        }
        if (item.type === "response.completed") {
          sawCompleted = true;
          if (item.response?.status === "incomplete") truncated = true;
          if (item.response?.usage) usage.usage(item.response.usage);
        }
      } catch (error) {
        // In-band upstream failures must end the stream; only parse noise is ignored.
        if (error instanceof UpstreamFailure) throw error;
      }
    };
    try {
      await drain(reader, consume);
      if (!sawCompleted) {
        const message = "Upstream Responses stream ended before response.completed was received.";
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

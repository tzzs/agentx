import type { ServerResponse } from "node:http";
import { jsonRecord, recObj, recStr } from "../json.js";
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
        const item = jsonRecord(JSON.parse(value));
        const failure = failureMessage(item);
        if (failure) throw new UpstreamFailure(failure);
        const delta = recStr(item, "delta");
        if (item.type === "response.output_text.delta" && delta !== undefined) { capture.output++; chunk({ content: delta }); }
        const reasoning = reasoningDeltaOf(item);
        if (reasoning) chunk({ reasoning_content: reasoning });
        const addedItem = recObj(item, "item");
        if (item.type === "response.output_item.added" && addedItem?.type === "function_call") {
          const key = recStr(addedItem, "call_id") ?? recStr(addedItem, "id") ?? `call_${calls.size}`;
          calls.set(key, { index: calls.size, id: key, name: recStr(addedItem, "name") ?? "", announced: false });
        }
        if (item.type === "response.function_call_arguments.delta" && delta !== undefined) {
          const key = recStr(item, "call_id") ?? recStr(item, "item_id") ?? "";
          const call = calls.get(key) ?? { index: calls.size, id: key, name: recStr(item, "name") ?? "", announced: false };
          calls.set(key, call);
          emitChatToolDelta(chunk, call, call.index, delta);
        }
        if (item.type === "response.completed") {
          sawCompleted = true;
          const completed = recObj(item, "response");
          if (completed?.status === "incomplete") truncated = true;
          const completedUsage = recObj(completed, "usage");
          if (completedUsage) usage.usage(completedUsage);
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

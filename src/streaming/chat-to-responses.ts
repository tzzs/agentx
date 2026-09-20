import type { ServerResponse } from "node:http";
import { chatResponseFailure } from "../convert/index.js";
import {
  announceMessageItem, announceReasoning, dataLine, drain, emitFunctionCallDelta,
  emitReasoningDelta, emitResponsesCompleted, emitResponsesError, emitTextDelta, event, failureMessage,
  newUsageCapture, reasoningDeltaOf, reportUsage, usageCapture, withSsePipe,
  UpstreamFailure, type ReasoningState, type StreamUsageOptions,
} from "./common.js";
import { jsonRecord, recNum, recObj, recObjs, recStr } from "../json.js";

/**
 * Pipe a Chat Completions SSE upstream into Codex-style Responses events. Used
 * for non-OpenCode providers that still speak the legacy chat protocol.
 */
export async function pipeChatStreamToResponses(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  await withSsePipe(upstream, response, async (reader) => {
    const id = `resp_${crypto.randomUUID()}`; const msgId = `msg_${crypto.randomUUID()}`;
    const capture = newUsageCapture();
    const usage = usageCapture(capture, "chat-completions");
    let text = ""; let truncated = false;
    const messageAnnounced = { done: false };
    const reasoning: ReasoningState = { id: "", text: "" };
    const calls = new Map<number, { id: string; name: string; arguments: string; announced: boolean }>();
    // A chat-completions upstream must close every turn with either a
    // finish_reason or [DONE]; seeing neither means the connection dropped
    // mid-turn and must not read back as a normal "completed" response.
    let sawFinishReason = false; let sawDone = false;
    event(response, "response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [] } });
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
        if (finishReason !== undefined) {
          sawFinishReason = true;
          const chatFailure = chatResponseFailure(item);
          if (chatFailure) { options?.onDiagnostic?.(`chat completions finish_reason=${finishReason}: ${chatFailure}`); throw new UpstreamFailure(chatFailure); }
        }
        if (finishReason === "length") truncated = true;
        const content = recStr(delta, "content");
        if (content) {
          announceMessageItem(response, msgId, messageAnnounced);
          text += content; capture.output++; emitTextDelta(response, msgId, content);
        }
        const reasoningDelta = reasoningDeltaOf(item);
        if (reasoningDelta) {
          announceReasoning(response, reasoning);
          emitReasoningDelta(response, reasoning, reasoningDelta);
        }
        for (const tool of recObjs(delta, "tool_calls")) {
          const index = recNum(tool, "index") ?? 0;
          const toolId = recStr(tool, "id");
          // Announce each call exactly once even when providers repeat id/name in deltas.
          const call = calls.get(index) ?? { id: toolId ?? `call_${index}`, name: "", arguments: "", announced: false };
          if (toolId) call.id = toolId;
          const toolFunction = recObj(tool, "function");
          const toolName = recStr(toolFunction, "name");
          if (toolName) call.name = toolName;
          calls.set(index, call);
          if (!call.announced) { event(response, "response.output_item.added", { type: "response.output_item.added", output_index: index, item: { type: "function_call", id: `fc_${index}`, call_id: call.id, name: call.name, arguments: "", status: "in_progress" } }); call.announced = true; }
          const partialJson = recStr(toolFunction, "arguments");
          if (partialJson) {
            call.arguments += partialJson;
            emitFunctionCallDelta(response, { itemId: `fc_${index}`, outputIndex: index, callId: call.id, delta: partialJson });
          }
        }
        const itemUsage = recObj(item, "usage");
        if (itemUsage) usage.usage(itemUsage);
      } catch (error) {
        // In-band upstream failures must end the stream; only parse noise is ignored.
        if (error instanceof UpstreamFailure) throw error;
      }
    };
    try {
      await drain(reader, consume);
      if (!sawFinishReason && !sawDone) {
        const message = "Upstream chat completions stream ended before a finish_reason or [DONE] was received.";
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

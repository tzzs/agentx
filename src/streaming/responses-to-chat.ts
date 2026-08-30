import type { ServerResponse } from "node:http";
import { cancelOnDisconnect, drain, errorMessage, failureMessage, reasoningDeltaOf, reportUsage, SSE_HEADERS, startHeartbeat, UpstreamFailure, type StreamUsageOptions } from "./common.js";

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
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startHeartbeat(response);
  try {
  const id = `chatcmpl_${crypto.randomUUID()}`; const created = Math.floor(Date.now() / 1000);
  let inputTokens = 0; let outputTokens = 0; let sawUsage = false; let truncated = false; let lastUsage: any; let sawCompleted = false;
  const calls = new Map<string, { index: number; name: string; announced: boolean }>();
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  };
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value) return;
    try {
      const item = JSON.parse(value);
      const failure = failureMessage(item);
      if (failure) throw new UpstreamFailure(failure);
      if (item.type === "response.output_text.delta" && typeof item.delta === "string") { outputTokens++; chunk({ content: item.delta }); }
      const reasoning = reasoningDeltaOf(item);
      if (typeof reasoning === "string") chunk({ reasoning_content: reasoning });
      if (item.type === "response.output_item.added" && item.item?.type === "function_call") {
        const key = item.item.call_id ?? item.item.id ?? `call_${calls.size}`;
        calls.set(key, { index: calls.size, name: item.item.name ?? "", announced: false });
      }
      if (item.type === "response.function_call_arguments.delta" && typeof item.delta === "string") {
        const key = item.call_id ?? item.item_id ?? "";
        const call = calls.get(key) ?? { index: calls.size, name: item.name ?? "", announced: false };
        calls.set(key, call);
        const toolCall: Record<string, unknown> = { index: call.index, function: { arguments: item.delta } };
        if (!call.announced) { call.announced = true; toolCall.id = key; toolCall.type = "function"; (toolCall.function as any).name = call.name; }
        chunk({ tool_calls: [toolCall] });
      }
      if (item.type === "response.completed") {
        sawCompleted = true;
        if (item.response?.status === "incomplete") truncated = true;
        if (item.response?.usage) { inputTokens = item.response.usage.input_tokens ?? inputTokens; outputTokens = item.response.usage.output_tokens ?? outputTokens; lastUsage = item.response.usage; sawUsage = true; }
      }
    } catch (error) {
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
    chunk({ content: `\n[error: ${errorMessage(error)}]` }, "stop");
    response.write("data: [DONE]\n\n");
  }
  response.end();
  reportUsage(options, sawUsage, inputTokens, outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

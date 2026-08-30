import type { ServerResponse } from "node:http";
import { cancelOnDisconnect, drain, errorMessage, reportUsage, SSE_HEADERS, startHeartbeat, UpstreamFailure, type StreamUsageOptions } from "./common.js";

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
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startHeartbeat(response);
  try {
  const id = `chatcmpl_${crypto.randomUUID()}`; const created = Math.floor(Date.now() / 1000);
  let inputTokens = 0; let outputTokens = 0; let sawUsage = false; let truncated = false; let lastUsage: any;
  let sawMessageStop = false;
  const calls = new Map<number, { id: string; name: string; announced: boolean }>();
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  };
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value) return;
    try {
      const item = JSON.parse(value);
      if (item.type === "error") throw new UpstreamFailure(item.error?.message ?? "Upstream stream failed");
      if (item.type === "message_start" && item.message?.usage) {
        inputTokens = item.message.usage.input_tokens ?? inputTokens;
        outputTokens = item.message.usage.output_tokens ?? outputTokens;
      }
      if (item.type === "content_block_start" && item.content_block?.type === "tool_use") {
        calls.set(item.index, { id: item.content_block.id ?? `call_${item.index}`, name: item.content_block.name ?? "", announced: false });
      }
      if (item.type === "content_block_delta") {
        const delta = item.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") { outputTokens++; chunk({ content: delta.text }); }
        else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") { chunk({ reasoning_content: delta.thinking }); }
        else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const call = calls.get(item.index);
          if (call) {
            const toolCall: Record<string, unknown> = { index: item.index, function: { arguments: delta.partial_json } };
            if (!call.announced) { call.announced = true; toolCall.id = call.id; toolCall.type = "function"; (toolCall.function as any).name = call.name; }
            chunk({ tool_calls: [toolCall] });
          }
        }
      }
      if (item.type === "message_delta") {
        if (item.delta?.stop_reason === "max_tokens") truncated = true;
        if (item.usage) { outputTokens = item.usage.output_tokens ?? outputTokens; lastUsage = item.usage; sawUsage = true; }
      }
      if (item.type === "message_stop") sawMessageStop = true;
    } catch (error) {
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
    chunk({ content: `\n[error: ${errorMessage(error)}]` }, "stop");
    response.write("data: [DONE]\n\n");
  }
  response.end();
  reportUsage(options, sawUsage, inputTokens, outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

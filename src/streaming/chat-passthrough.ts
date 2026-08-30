import type { ServerResponse } from "node:http";
import { cancelOnDisconnect, drain, errorMessage, reportUsage, SSE_HEADERS, startHeartbeat, withCacheTokens, type StreamUsageOptions } from "./common.js";
import type { TokenUsage } from "../usage/types.js";

/**
 * Forward a Chat Completions SSE stream byte-for-byte. Used for the local
 * `/v1/chat/completions` endpoint against an upstream whose protocol is
 * already "chat-completions": both sides speak the same grammar, so there is
 * nothing to translate — mirrors `pipeAnthropicPassthrough`/
 * `pipeResponsesPassthrough`'s role for their own native upstreams. Usage
 * only arrives when the caller requested `stream_options.include_usage`; a
 * per-delta count of text chunks backs the `estimated` fallback when it does
 * not.
 */
export async function pipeChatPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  const stopHeartbeat = startHeartbeat(response);
  try {
  let usage: TokenUsage | null = null; let inputTokens = 0; let outputTokens = 0; let lastUsage: any;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      const delta = item.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) outputTokens++;
      if (item.usage) {
        inputTokens = item.usage.prompt_tokens ?? inputTokens; const usageOutputTokens = item.usage.completion_tokens ?? outputTokens;
        lastUsage = item.usage;
        usage = withCacheTokens({ provider: options?.provider ?? "", model, inputTokens, outputTokens: usageOutputTokens, totalTokens: item.usage.total_tokens ?? (inputTokens + usageOutputTokens), ...(options?.sessionId ? { sessionId: options.sessionId } : {}) }, item.usage);
      }
    } catch { /* Ignore incomplete provider events. */ }
  };
  try {
    // Forward the decoded chunks verbatim; SSE is text so this is byte-faithful.
    await drain(reader, consume, (chunk) => response.write(chunk));
  } catch (error) {
    response.write(`data: {"error":{"message":${JSON.stringify(errorMessage(error))},"type":"upstream_error"}}\n\n`);
  }
  response.end();
  reportUsage(options, usage !== null, (usage as TokenUsage | null)?.inputTokens ?? inputTokens, (usage as TokenUsage | null)?.outputTokens ?? outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

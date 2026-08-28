import type { ServerResponse } from "node:http";
import { cancelOnDisconnect, drain, errorMessage, event, reportUsage, SSE_HEADERS, startHeartbeat, withCacheTokens, type StreamUsageOptions } from "./common.js";
import type { TokenUsage } from "../usage/types.js";

/**
 * Forward a native Anthropic Messages SSE stream byte-for-byte. Used for
 * Claude Code against a custom provider whose protocol is "anthropic": both
 * sides already speak the same event grammar, so there is nothing to
 * translate — this mirrors `pipeResponsesPassthrough`'s role for a
 * Responses-native upstream. Usage arrives split across two events:
 * `message_start` carries the initial input token count, `message_delta`
 * carries the final output token count (and, via `withCacheTokens`, cache
 * token fields) once the turn completes.
 */
export async function pipeAnthropicPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  // try/finally guarantees the interval is cleared even if a write to the
  // local client throws before the main try block is entered.
  const stopHeartbeat = startHeartbeat(response);
  try {
  let usage: TokenUsage | null = null; let inputTokens = 0; let outputTokens = 0; let lastUsage: any;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value) return;
    try {
      const item = JSON.parse(value);
      if (item.type === "message_start" && item.message?.usage) {
        inputTokens = item.message.usage.input_tokens ?? inputTokens;
        outputTokens = item.message.usage.output_tokens ?? outputTokens;
      }
      if (item.type === "message_delta" && item.usage && options) {
        outputTokens = item.usage.output_tokens ?? outputTokens;
        lastUsage = item.usage;
        usage = withCacheTokens({ provider: options.provider, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }, item.usage);
      }
    } catch { /* Ignore incomplete provider events. */ }
  };
  try {
    // Forward the decoded chunks verbatim; SSE is text so this is byte-faithful.
    await drain(reader, consume, (chunk) => response.write(chunk));
  } catch (error) {
    event(response, "error", { type: "error", error: { type: "api_error", message: errorMessage(error) } });
  }
  response.end();
  reportUsage(options, usage !== null, (usage as TokenUsage | null)?.inputTokens ?? inputTokens, (usage as TokenUsage | null)?.outputTokens ?? outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

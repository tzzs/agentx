import type { ServerResponse } from "node:http";
import { cancelOnDisconnect, drain, errorMessage, event, reportUsage, SSE_HEADERS, startHeartbeat, withCacheTokens, type StreamUsageOptions } from "./common.js";
import type { TokenUsage } from "../usage/types.js";

/**
 * Forward a Responses-protocol SSE stream byte-for-byte. Usage is captured from
 * `response.completed` and reported through `onUsage`; the local client sees
 * the same events the upstream emitted.
 */
export async function pipeResponsesPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  // try/finally guarantees the interval is cleared even if a write to the
  // local client throws before the main try block is entered.
  const stopHeartbeat = startHeartbeat(response);
  try {
  let usage: TokenUsage | null = null; let outputTokens = 0; let lastUsage: any;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      if (item.type === "response.output_text.delta" && typeof item.delta === "string") outputTokens++;
      if (item.response?.usage && options) {
        const inputTokens = item.response.usage.input_tokens ?? 0; const usageOutputTokens = item.response.usage.output_tokens ?? 0;
        lastUsage = item.response.usage;
        usage = withCacheTokens({ provider: options.provider, model, inputTokens, outputTokens: usageOutputTokens, totalTokens: item.response.usage.total_tokens ?? (inputTokens + usageOutputTokens), ...(options.sessionId ? { sessionId: options.sessionId } : {}) }, item.response.usage);
      }
    } catch { /* Ignore incomplete provider events. */ }
  };
  try {
    // Forward the decoded chunks verbatim; SSE is text so this is byte-faithful.
    await drain(reader, consume, (chunk) => response.write(chunk));
  } catch (error) {
    const id = `resp_${crypto.randomUUID()}`;
    event(response, "response.failed", { type: "response.failed", response: { id, object: "response", status: "failed", model, error: { code: "upstream_error", message: errorMessage(error) } } });
  }
  response.end();
  reportUsage(options, usage !== null, (usage as TokenUsage | null)?.inputTokens ?? 0, (usage as TokenUsage | null)?.outputTokens ?? outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

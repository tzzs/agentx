import type { ServerResponse } from "node:http";
import type { TokenUsage } from "../usage/types.js";
import type { ProviderProtocol } from "../providers/types.js";

export const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

/** How often to emit an SSE comment while the upstream is quiet. */
export const HEARTBEAT_MS = 15_000;

/** Dedicated high output_index for synthesized reasoning items so they never collide with text (0) or tool call indexes. */
export const REASONING_OUTPUT_INDEX = 1000;

/** Shared by all stream pipes; the only place that owns usage capture and reporting. */
export interface StreamUsageOptions {
  provider: string;
  model: string;
  protocol: ProviderProtocol;
  sessionId?: string;
  onUsage?: (usage: TokenUsage) => void;
  onDiagnostic?: (message: string) => void;
}

/**
 * SSE comment lines during long upstream silences. Clients and intermediate
 * hops ignore them, but they reset idle timeouts so the turn is not dropped.
 */
export function startHeartbeat(response: ServerResponse) {
  const timer = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** A failure carried inside otherwise valid SSE data; must end the stream. */
export class UpstreamFailure extends Error {}

/** Message of an in-band upstream error payload, if the parsed event carries one. */
export function failureMessage(item: any): string | undefined {
  if (item.type === "response.failed") return item.response?.error?.message ?? item.response?.error ?? "Upstream response failed";
  if (item.type === "error") return item.error?.message ?? (typeof item.message === "string" ? item.message : undefined) ?? "Upstream stream failed";
  if (typeof item.error?.message === "string") return item.error.message;
  return undefined;
}

export function event(response: ServerResponse, type: string, data: unknown) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Upstream stream failed";
}

/** Stop reading from the upstream as soon as the local client disconnects. */
export function cancelOnDisconnect(response: ServerResponse, reader: ReadableStreamDefaultReader<Uint8Array>) {
  response.on("close", () => { void reader.cancel().catch(() => {}); });
}

/** Read the upstream SSE body line by line; `onChunk` sees each decoded chunk (passthrough). */
export async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, consume: (line: string) => void, onChunk?: (text: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    const text = decoder.decode(value ?? new Uint8Array(), { stream: !done });
    if (text && onChunk) onChunk(text);
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(consume);
    if (done) {
      // A valid SSE event may end at EOF without a trailing newline.
      if (buffer) consume(buffer);
      return;
    }
  }
}

/** Cache-token fields shared by chat-completions, Responses, and Anthropic usage payloads. */
export function cacheTokensOf(usage: any): { cached?: number; reasoning?: number } {
  const cached = usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? usage?.cached_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens;
  return {
    ...(cached === undefined || cached === null ? {} : { cached: Number(cached) }),
    ...(reasoning === undefined || reasoning === null ? {} : { reasoning: Number(reasoning) }),
  };
}

/** Attach captured cache/reasoning tokens to a usage record when present. */
export function withCacheTokens(usage: TokenUsage, source: any): TokenUsage {
  const { cached, reasoning } = cacheTokensOf(source);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

function estimatedUsage(provider: string, model: string, inputTokens: number, outputTokens: number, sessionId?: string): TokenUsage {
  return { provider, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true, ...(sessionId ? { sessionId } : {}) };
}

/** Reasoning text shared by Responses (`reasoning_summary_text`/`reasoning_text`) and chat (`reasoning_content`/`reasoning`) deltas. */
export function reasoningDeltaOf(item: any): string | undefined {
  const delta = item.choices?.[0]?.delta;
  const chat = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof chat === "string" && chat) return chat;
  if (item.type === "response.reasoning_summary_text.delta" || item.type === "response.reasoning_text.delta") {
    const value = item.delta;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Final usage reporting; called by every pipe. */
export function reportUsage(options: StreamUsageOptions | undefined, sawUsage: boolean, inputTokens: number, outputTokens: number, lastUsage?: any) {
  if (!options?.onUsage) return;
  options.onUsage(sawUsage
    ? withCacheTokens({ provider: options.provider, model: options.model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }, lastUsage)
    : estimatedUsage(options.provider, options.model, inputTokens, outputTokens, options.sessionId));
}

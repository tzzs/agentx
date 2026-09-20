import type { ServerResponse } from "node:http";
import type { TokenUsage } from "../usage/types.js";
import type { ProviderProtocol } from "../providers/types.js";
import { mapAnthropicUsage, mapChatUsage, mapResponsesUsage } from "../providers/usage/index.js";

export const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

/** How often to emit an SSE comment while the upstream is quiet. */
const HEARTBEAT_MS = 15_000;

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
function startHeartbeat(response: ServerResponse) {
  const timer = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** Stop reading from the upstream as soon as the local client disconnects. */
function cancelOnDisconnect(response: ServerResponse, reader: ReadableStreamDefaultReader<Uint8Array>) {
  response.on("close", () => { void reader.cancel().catch(() => {}); });
}

/**
 * Shared preamble/teardown for every stream pipe: take the upstream reader,
 * arm disconnect cancellation, send SSE headers, and run `run` with the SSE
 * heartbeat active (cleared even if setup or `run` throws).
 */
export async function withSsePipe(upstream: Response, response: ServerResponse, run: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<void>): Promise<void> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  // try/finally guarantees the interval is cleared even if a write to the
  // local client throws before the main try block is entered.
  const stopHeartbeat = startHeartbeat(response);
  try {
    await run(reader);
  } finally {
    stopHeartbeat();
  }
}

/** Payload of an SSE `data:` line, or undefined for non-data/blank lines. */
export function dataLine(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  return line.slice(5).trim() || undefined;
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

/**
 * Terminal error handling per client-facing protocol grammar:
 * Anthropic clients expect a final `error` event, Responses clients a
 * `response.failed`, and Chat Completions clients — whose chunk grammar has
 * no error event pair — get the message inlined as content before [DONE].
 */
export function emitAnthropicError(response: ServerResponse, error: unknown) {
  event(response, "error", { type: "error", error: { type: "api_error", message: errorMessage(error) } });
}

export function emitResponsesError(response: ServerResponse, id: string, model: string, error: unknown) {
  event(response, "response.failed", { type: "response.failed", response: { id, object: "response", status: "failed", model, error: { code: "upstream_error", message: errorMessage(error) } } });
}

export function emitChatError(response: ServerResponse, chunk: (delta: Record<string, unknown>, finishReason?: string | null) => void, error: unknown) {
  chunk({ content: `\n[error: ${errorMessage(error)}]` }, "stop");
  response.write("data: [DONE]\n\n");
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

/**
 * Cache-token fields shared by chat-completions, Responses, and Anthropic
 * usage payloads. A stream pipe doesn't always know in advance which shape
 * `usage` will turn out to be (pipeResponsesStream in to-anthropic.ts serves
 * whichever of the two non-Anthropic upstream protocols is actually
 * configured, and can even be called with no options at all — see its
 * message_delta construction), so this tries every protocol's field mapper
 * and keeps the first hit; each mapper's own field list is the single source
 * of truth (providers/usage/*.ts), not duplicated here.
 */
export function cacheTokensOf(usage: any): { cached?: number; reasoning?: number } {
  const chat = mapChatUsage(usage, {});
  const responses = mapResponsesUsage(usage, {});
  const anthropic = mapAnthropicUsage(usage, {});
  const cached = chat?.cachedInputTokens ?? responses?.cachedInputTokens ?? anthropic?.cachedInputTokens
    ?? (usage?.cached_tokens === undefined || usage?.cached_tokens === null ? undefined : Number(usage.cached_tokens));
  const reasoning = chat?.reasoningTokens ?? responses?.reasoningTokens;
  return {
    ...(cached === undefined ? {} : { cached }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** Attach captured cache/reasoning tokens to a usage record when present. */
export function withCacheTokens(usage: TokenUsage, source: any): TokenUsage {
  const { cached, reasoning } = cacheTokensOf(source);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

/** Per-request token counters every pipe tracks; the single store pipes read when emitting and reporting usage. */
export interface UsageCapture {
  input: number;
  output: number;
  /** The most recent raw upstream usage payload, for protocol-shape-dependent emission (e.g. Anthropic cache_read). */
  raw?: any;
  sawUsage: boolean;
  /** Cache/reasoning fields mapped from the latest raw usage via the provider field mappers. */
  cached?: number;
  reasoning?: number;
  cacheWrite?: number;
}

export function newUsageCapture(): UsageCapture {
  return { input: 0, output: 0, sawUsage: false };
}

function mapRawUsage(raw: any, protocol: ProviderProtocol): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  switch (protocol) {
    // Bare-usage field lists live in providers/usage/*; the core never parses
    // provider payloads itself (CLAUDE.md architecture rule).
    case "anthropic": return mapAnthropicUsage(raw, {});
    case "responses": return mapResponsesUsage(raw, {});
    case "chat-completions": return mapChatUsage(raw, {});
  }
}

/**
 * Bind usage capture to the upstream protocol so token fields are read via
 * the same provider field mappers as the non-streaming path. `usage()` merges
 * a raw usage object into the capture; `total()` prefers the upstream's own
 * total when it carries one. `enabled=false` (a pipe called with no options)
 * keeps raw payloads as estimation hints without claiming real usage, which
 * `reportUsage`'s fallback then reports.
 */
export function usageCapture(capture: UsageCapture, protocol: ProviderProtocol, enabled = true): {
  usage(raw: any): void;
  total(): number;
} {
  return {
    usage(raw) {
      const mapped = mapRawUsage(raw, protocol);
      if (!mapped) return;
      capture.raw = raw;
      if (!enabled) return;
      capture.sawUsage = true;
      if (mapped.inputTokens) capture.input = mapped.inputTokens;
      if (mapped.outputTokens) capture.output = mapped.outputTokens;
      if (mapped.cachedInputTokens !== undefined) capture.cached = mapped.cachedInputTokens;
      if (mapped.reasoningTokens !== undefined) capture.reasoning = mapped.reasoningTokens;
      if (mapped.cacheWriteTokens !== undefined) capture.cacheWrite = mapped.cacheWriteTokens;
    },
    total() {
      return Number(capture.raw?.total_tokens ?? capture.input + capture.output);
    },
  };
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

/** Final usage reporting; called by every pipe. Captured fields ride on the
 * usage record itself; a stream that never carried a usage payload reports an
 * estimate from the per-delta counters instead. */
export function reportUsage(options: StreamUsageOptions | undefined, capture: UsageCapture, totalOverride?: number) {
  if (!options?.onUsage) return;
  if (!capture.sawUsage) {
    options.onUsage(estimatedUsage(options.provider, options.model, capture.input, capture.output, options.sessionId));
    return;
  }
  const usage: TokenUsage = { provider: options.provider, model: options.model, inputTokens: capture.input, outputTokens: capture.output, totalTokens: totalOverride ?? capture.input + capture.output, ...(options.sessionId ? { sessionId: options.sessionId } : {}) };
  if (capture.cached !== undefined) usage.cachedInputTokens = capture.cached;
  if (capture.reasoning !== undefined) usage.reasoningTokens = capture.reasoning;
  if (capture.cacheWrite !== undefined) usage.cacheWriteTokens = capture.cacheWrite;
  options.onUsage(usage);
}

/* ---------- Responses-protocol (Codex-facing) emitters ---------- */

/** Per-pipe state for the synthesized reasoning item (`rs_*` id plus accumulated text). */
export interface ReasoningState {
  id: string;
  text: string;
}

/** Announce the reasoning item once, when the first reasoning delta arrives. */
export function announceReasoning(response: ServerResponse, state: ReasoningState) {
  if (state.id) return;
  state.id = `rs_${crypto.randomUUID()}`;
  event(response, "response.output_item.added", { type: "response.output_item.added", output_index: REASONING_OUTPUT_INDEX, item: { type: "reasoning", id: state.id, summary: [] } });
  event(response, "response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: state.id, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, part: { type: "summary_text", text: "" } });
}

export function emitReasoningDelta(response: ServerResponse, state: ReasoningState, delta: string) {
  state.text += delta;
  event(response, "response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: state.id, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, delta });
}

/** Close out the reasoning item; both Responses-facing pipes emit the identical terminal triplet. */
export function emitReasoningDone(response: ServerResponse, state: ReasoningState) {
  if (!state.id) return;
  event(response, "response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: state.id, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, text: state.text });
  event(response, "response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: state.id, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, part: { type: "summary_text", text: state.text } });
  event(response, "response.output_item.done", { type: "response.output_item.done", output_index: REASONING_OUTPUT_INDEX, item: { type: "reasoning", id: state.id, summary: [{ type: "summary_text", text: state.text }] } });
}

/** Announce the assistant message item once, when the first text delta arrives. */
export function announceMessageItem(response: ServerResponse, msgId: string, announced: { done: boolean }) {
  // Codex keys text on the announced message item; announce it once.
  if (announced.done) return;
  announced.done = true;
  event(response, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] } });
}

export function emitTextDelta(response: ServerResponse, msgId: string, delta: string) {
  event(response, "response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta });
}

export function emitFunctionCallDelta(response: ServerResponse, args: { itemId: string; outputIndex?: number; callId: string; delta: string }) {
  event(response, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: args.itemId,
    ...(args.outputIndex === undefined ? {} : { output_index: args.outputIndex }),
    call_id: args.callId,
    delta: args.delta,
  });
}

export function reasoningItem(state: ReasoningState) {
  return { type: "reasoning", id: state.id, summary: [{ type: "summary_text", text: state.text }] };
}

export function messageItem(msgId: string, text: string) {
  return { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}

export function functionCallItem(call: { id: string; name: string; arguments: string }, index: number | string) {
  return { type: "function_call", id: `fc_${index}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" };
}

/**
 * Finalize the turn for Responses-facing clients: text/reasoning done events,
 * per-call argument-done + item-done events, then the completed response —
 * Codex strictly requires total_tokens there. Chat-style `calls` carry no
 * `arguments`, so the caller supplies them via `argsOf`.
 */
export function emitResponsesCompleted(
  response: ServerResponse,
  args: {
    id: string;
    model: string;
    capture: UsageCapture;
    truncated: boolean;
    text?: string;
    msgId?: string;
    reasoning?: ReasoningState;
    calls: Iterable<[number | string, { id: string; name: string; arguments?: string }]>;
    argsOf?(index: number | string): string;
  },
) {
  const { id, model, capture, truncated } = args;
  if (args.reasoning) emitReasoningDone(response, args.reasoning);
  if (args.text) {
    const msgId = args.msgId ?? "";
    event(response, "response.output_text.done", { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text: args.text });
    // Codex collects turn items from output_item.done; the message must be
    // finalized there or only the reasoning/tool items reach the client.
    event(response, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: messageItem(msgId, args.text) });
  }
  const output: unknown[] = [];
  if (args.reasoning?.id) output.push(reasoningItem(args.reasoning));
  if (args.text) output.push(messageItem(args.msgId ?? "", args.text));
  for (const [index, call] of args.calls) {
    const callArgs = call.arguments ?? args.argsOf?.(index) ?? "";
    event(response, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: `fc_${index}`, call_id: call.id, arguments: callArgs });
    event(response, "response.output_item.done", { type: "response.output_item.done", output_index: index, item: functionCallItem({ ...call, arguments: callArgs }, index) });
    output.push(functionCallItem({ ...call, arguments: callArgs }, index));
  }
  event(response, "response.completed", { type: "response.completed", response: { id, object: "response", status: truncated ? "incomplete" : "completed", model, output, usage: { input_tokens: capture.input, output_tokens: capture.output, total_tokens: capture.input + capture.output }, ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } });
  response.write("data: [DONE]\n\n");
}

/* ---------- Chat-Completions-protocol emitters ---------- */

export interface ChatToolCallState {
  id: string;
  name: string;
  announced: boolean;
}

/** `data:` writer for `chat.completion.chunk` events, shared by both Chat-facing pipes. */
export function createChatEmitter(response: ServerResponse, model: string) {
  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  return function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  };
}

/** Emit one streamed tool-call delta, announcing id/name/type on the first chunk for that call. */
export function emitChatToolDelta(chunk: (delta: Record<string, unknown>, finishReason?: string | null) => void, call: ChatToolCallState, index: number, args: string) {
  const fn: Record<string, unknown> = { arguments: args };
  const delta: Record<string, unknown> = { index, function: fn };
  if (!call.announced) { call.announced = true; delta.id = call.id; delta.type = "function"; fn.name = call.name; }
  chunk({ tool_calls: [delta] });
}

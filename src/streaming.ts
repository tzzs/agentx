import type { ServerResponse } from "node:http";
import type { TokenUsage } from "./usage/types.js";

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

/** How often to emit an SSE comment while the upstream is quiet. */
const HEARTBEAT_MS = 15_000;

/** Dedicated high output_index for synthesized reasoning items so they never collide with text (0) or tool call indexes. */
const REASONING_OUTPUT_INDEX = 1000;

/**
 * SSE comment lines during long upstream silences. Clients and intermediate
 * hops ignore them, but they reset idle timeouts so the turn is not dropped.
 */
function startHeartbeat(response: ServerResponse) {
  const timer = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
  return () => clearInterval(timer);
}

/** A failure carried inside otherwise valid SSE data; must end the stream. */
class UpstreamFailure extends Error {}

/** Message of an in-band upstream error payload, if the parsed event carries one. */
function failureMessage(item: any): string | undefined {
  if (item.type === "response.failed") return item.response?.error?.message ?? item.response?.error ?? "Upstream response failed";
  if (item.type === "error") return item.error?.message ?? (typeof item.message === "string" ? item.message : undefined) ?? "Upstream stream failed";
  if (typeof item.error?.message === "string") return item.error.message;
  return undefined;
}

function event(response: ServerResponse, type: string, data: unknown) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Upstream stream failed";
}

export interface StreamUsageOptions {
  provider: string;
  model: string;
  protocol: "responses" | "chat-completions";
  sessionId?: string;
  onUsage?: (usage: TokenUsage) => void;
}

function estimatedUsage(provider: string, model: string, inputTokens: number, outputTokens: number, sessionId?: string): TokenUsage {
  return { provider, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true, ...(sessionId ? { sessionId } : {}) };
}

/** Cache-token fields shared by chat-completions and Responses usage payloads. */
function cacheTokensOf(usage: any): { cached?: number; reasoning?: number } {
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
function withCacheTokens(usage: TokenUsage, source: any): TokenUsage {
  const { cached, reasoning } = cacheTokensOf(source);
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

/** Reasoning text shared by Responses (`reasoning_summary_text`/`reasoning_text`) and chat (`reasoning_content`/`reasoning`) deltas. */
function reasoningDeltaOf(item: any): string | undefined {
  const delta = item.choices?.[0]?.delta;
  const chat = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof chat === "string" && chat) return chat;
  if (item.type === "response.reasoning_summary_text.delta" || item.type === "response.reasoning_text.delta") {
    const value = item.delta;
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Stop reading from the upstream as soon as the local client disconnects. */
function cancelOnDisconnect(response: ServerResponse, reader: ReadableStreamDefaultReader<Uint8Array>) {
  response.on("close", () => { void reader.cancel().catch(() => {}); });
}

/** Read the upstream SSE body line by line; `onChunk` sees each decoded chunk (passthrough). */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, consume: (line: string) => void, onChunk?: (text: string) => void) {
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
    if (done) return;
  }
}

export async function pipeChatStreamToResponses(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  // try/finally guarantees the interval is cleared even if a write to the
  // local client throws.
  const stopHeartbeat = startHeartbeat(response);
  try {
  const id = `resp_${crypto.randomUUID()}`; const msgId = `msg_${crypto.randomUUID()}`; let text = ""; let inputTokens = 0; let outputTokens = 0; let sawUsage = false; let truncated = false; let lastUsage: any; let rsId = ""; let rsText = ""; let messageAnnounced = false; const calls = new Map<number, { id: string; name: string; arguments: string; announced: boolean }>();
  event(response, "response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [] } });
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      const failure = failureMessage(item);
      if (failure) throw new UpstreamFailure(failure);
      const choice = item.choices?.[0]; const delta = choice?.delta?.content;
      if (choice?.finish_reason === "length") truncated = true;
      if (typeof delta === "string" && delta) {
        // Codex keys text on the announced message item; announce it once.
        if (!messageAnnounced) {
          messageAnnounced = true;
          event(response, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] } });
        }
        text += delta; outputTokens++; event(response, "response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta });
      }
      const reasoningDelta = reasoningDeltaOf(item);
      if (reasoningDelta) {
        if (!rsId) {
          rsId = `rs_${crypto.randomUUID()}`;
          event(response, "response.output_item.added", { type: "response.output_item.added", output_index: REASONING_OUTPUT_INDEX, item: { type: "reasoning", id: rsId, summary: [] } });
          event(response, "response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, part: { type: "summary_text", text: "" } });
        }
        rsText += reasoningDelta;
        event(response, "response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, delta: reasoningDelta });
      }
      for (const tool of choice?.delta?.tool_calls ?? []) {
        const index = tool.index ?? 0;
        // Announce each call exactly once even when providers repeat id/name in deltas.
        const call = calls.get(index) ?? { id: tool.id ?? `call_${index}`, name: "", arguments: "", announced: false };
        if (tool.id) call.id = tool.id;
        if (tool.function?.name) call.name = tool.function.name;
        calls.set(index, call);
        if (!call.announced) { event(response, "response.output_item.added", { type: "response.output_item.added", output_index: index, item: { type: "function_call", id: `fc_${index}`, call_id: call.id, name: call.name, arguments: "", status: "in_progress" } }); call.announced = true; }
        if (tool.function?.arguments) { call.arguments += tool.function.arguments; event(response, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: `fc_${index}`, output_index: index, call_id: call.id, delta: tool.function.arguments }); }
      }
      if (item.usage) { inputTokens = item.usage.prompt_tokens ?? inputTokens; outputTokens = item.usage.completion_tokens ?? outputTokens; lastUsage = item.usage; sawUsage = true; }
    } catch (error) {
      // In-band upstream failures must end the stream; only parse noise is ignored.
      if (error instanceof UpstreamFailure) throw error;
    }
  };
  try {
    await drain(reader, consume);
    if (rsId) {
      event(response, "response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, text: rsText });
      event(response, "response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, part: { type: "summary_text", text: rsText } });
      event(response, "response.output_item.done", { type: "response.output_item.done", output_index: REASONING_OUTPUT_INDEX, item: { type: "reasoning", id: rsId, summary: [{ type: "summary_text", text: rsText }] } });
    }
    if (text) {
      event(response, "response.output_text.done", { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text });
      // Codex collects turn items from output_item.done; the message must be
      // finalized there or only the reasoning item reaches the client.
      event(response, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } });
    }
    const output: any[] = [];
    if (rsId) output.push({ type: "reasoning", id: rsId, summary: [{ type: "summary_text", text: rsText }] });
    if (text) output.push({ type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
    for (const [index, call] of calls) {
      event(response, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: `fc_${index}`, call_id: call.id, arguments: call.arguments });
      event(response, "response.output_item.done", { type: "response.output_item.done", output_index: index, item: { type: "function_call", id: `fc_${index}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" } });
      output.push({ type: "function_call", id: `fc_${index}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" });
    }
    // Codex strictly requires total_tokens on the completed response usage.
    event(response, "response.completed", { type: "response.completed", response: { id, object: "response", status: truncated ? "incomplete" : "completed", model, output, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }, ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } });
    response.write("data: [DONE]\n\n");
  } catch (error) {
    event(response, "response.failed", { type: "response.failed", response: { id, object: "response", status: "failed", model, error: { code: "upstream_error", message: errorMessage(error) } } });
  }
  response.end();
  reportUsage(options, sawUsage, inputTokens, outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

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

export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  // try/finally guarantees the interval is cleared even if a write to the
  // local client throws before the main try block is entered.
  const stopHeartbeat = startHeartbeat(response);
  try {
  const id = `msg_${crypto.randomUUID()}`;
  event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  let outputTokens = 0; let inputTokens = 0; let sawUsage = false; let blockIndex = 0; let blockStarted = false; let blockType: "text" | "tool_use" | "thinking" | undefined; let toolStop = false; let truncated = false; let lastUsage: any;
  // Parallel tool calls arrive interleaved and keyed by chat `index` or
  // Responses `item_id`; each key gets its own Anthropic content block.
  const calls = new Map<string | number, { id: string; name: string }>();
  let activeTool: string | number | null = null;
  const stopBlock = () => { if (blockStarted) { event(response, "content_block_stop", { type: "content_block_stop", index: blockIndex }); blockStarted = false; blockType = undefined; blockIndex++; activeTool = null; } };
  const startText = () => {
    // Text after a tool call or thinking must not append to that block.
    if (!blockStarted || blockType !== "text") {
      stopBlock();
      event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
      blockStarted = true; blockType = "text";
    }
  };
  const startThinking = () => {
    if (!blockStarted || blockType !== "thinking") {
      stopBlock();
      event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "thinking", thinking: "" } });
      blockStarted = true; blockType = "thinking";
    }
  };
  const startTool = (id: string, name: string) => { stopBlock(); event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name, input: {} } }); blockStarted = true; blockType = "tool_use"; toolStop = true; };
  /** Switch to the block of another tool call when the stream jumps between them. */
  const openTool = (key: string | number, id: string, name: string) => {
    if (activeTool === key && blockStarted && blockType === "tool_use") return;
    startTool(id, name);
    activeTool = key;
  };
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      const failure = failureMessage(item);
      if (failure) throw new UpstreamFailure(failure);
      const choice = item.choices?.[0];
      if (choice?.finish_reason === "length") truncated = true;
      const reasoning = reasoningDeltaOf(item);
      if (typeof reasoning === "string") { startThinking(); event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: reasoning } }); }
      const text = item.type === "response.output_text.delta"
        ? item.delta
        : choice?.delta?.content;
      if (typeof text === "string" && text) { startText(); outputTokens++; event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } }); }
      const itemTool = item.type === "response.output_item.added" && item.item?.type === "function_call" ? item.item : undefined;
      const responseArgs = item.type === "response.function_call_arguments.delta" ? item.delta : undefined;
      for (const tool of choice?.delta?.tool_calls ?? []) {
        const key = tool.index ?? 0;
        const call = calls.get(key) ?? { id: tool.id ?? `call_${key}`, name: "" };
        if (tool.id) call.id = tool.id;
        if (tool.function?.name) call.name = tool.function.name;
        calls.set(key, call);
        openTool(key, call.id, call.name);
        if (tool.function?.arguments) event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: tool.function.arguments } });
      }
      if (itemTool) {
        const key = itemTool.call_id ?? itemTool.id ?? `call_${blockIndex}`;
        calls.set(key, { id: key, name: itemTool.name ?? "" });
        openTool(key, key, itemTool.name ?? "");
      }
      if (typeof responseArgs === "string") {
        const key = item.call_id ?? item.item_id ?? activeTool ?? "";
        const known = calls.get(key);
        openTool(key, key, item.name ?? known?.name ?? "");
        event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: responseArgs } });
      }
      if (item.response?.usage) { inputTokens = item.response.usage.input_tokens ?? inputTokens; outputTokens = item.response.usage.output_tokens ?? outputTokens; lastUsage = item.response.usage; sawUsage = true; }
      if (item.usage) { inputTokens = item.usage.prompt_tokens ?? inputTokens; outputTokens = item.usage.completion_tokens ?? outputTokens; lastUsage = item.usage; sawUsage = true; }
    } catch (error) {
      // In-band upstream failures must end the stream; only parse noise is ignored.
      if (error instanceof UpstreamFailure) throw error;
    }
  };
  try {
    await drain(reader, consume);
    if (!blockStarted) startText();
    stopBlock();
    const stopReason = truncated ? "max_tokens" : toolStop ? "tool_use" : "end_turn";
    const { cached } = cacheTokensOf(lastUsage);
    event(response, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: cached ?? 0 } });
    event(response, "message_stop", { type: "message_stop" });
  } catch (error) {
    // Match Anthropic semantics: a terminal error event closes the stream.
    stopBlock();
    event(response, "error", { type: "error", error: { type: "api_error", message: errorMessage(error) } });
  }
  response.end();
  reportUsage(options, sawUsage, inputTokens, outputTokens, lastUsage);
  } finally { stopHeartbeat(); }
}

function reportUsage(options: StreamUsageOptions | undefined, sawUsage: boolean, inputTokens: number, outputTokens: number, lastUsage?: any) {
  if (!options?.onUsage) return;
  options.onUsage(sawUsage
    ? withCacheTokens({ provider: options.provider, model: options.model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }, lastUsage)
    : estimatedUsage(options.provider, options.model, inputTokens, outputTokens, options.sessionId));
}

import type { ServerResponse } from "node:http";
import type { TokenUsage } from "./usage/types.js";

const HEARTBEAT_MS = 15000;
/** Dedicated high output_index for the synthesized reasoning item so it never collides with text (0) or chat tool call indexes. */
const REASONING_OUTPUT_INDEX = 1000;

function event(response: ServerResponse, type: string, data: unknown) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Emit SSE comments while the upstream is silent so clients and proxies keep the connection open. */
function keepAlive(response: ServerResponse) {
  const timer = setInterval(() => { try { response.write(": keep-alive\n\n"); } catch { /* client gone */ } }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
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

function detailedUsage(options: StreamUsageOptions, inputTokens: number, outputTokens: number, cachedInputTokens?: number, reasoningTokens?: number): TokenUsage {
  const sessionId = options.sessionId;
  if (cachedInputTokens === undefined && reasoningTokens === undefined) return { provider: options.provider, model: options.model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(sessionId ? { sessionId } : {}) };
  return {
    provider: options.provider, model: options.model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

interface UsageDetails { inputTokens: number; outputTokens: number; sawUsage: boolean; cached?: number; reasoning?: number; }

function readResponsesUsage(item: any, usage: UsageDetails) {
  const value = item.response?.usage;
  if (!value) return;
  usage.inputTokens = value.input_tokens ?? usage.inputTokens;
  usage.outputTokens = value.output_tokens ?? usage.outputTokens;
  const cached = value.input_tokens_details?.cached_tokens;
  if (cached !== undefined && cached !== null) usage.cached = Number(cached);
  const reasoning = value.output_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && reasoning !== null) usage.reasoning = Number(reasoning);
  usage.sawUsage = true;
}

function readChatUsage(item: any, usage: UsageDetails) {
  const value = item.usage;
  if (!value || (value.prompt_tokens === undefined && value.completion_tokens === undefined)) return;
  usage.inputTokens = value.prompt_tokens ?? usage.inputTokens;
  usage.outputTokens = value.completion_tokens ?? usage.outputTokens;
  const cached = value.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined && cached !== null) usage.cached = Number(cached);
  const reasoning = value.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && reasoning !== null) usage.reasoning = Number(reasoning);
  usage.sawUsage = true;
}

export async function pipeChatStreamToResponses(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const stopHeartbeat = keepAlive(response);
  const id = `resp_${crypto.randomUUID()}`; let text = ""; const usage: UsageDetails = { inputTokens: 0, outputTokens: 0, sawUsage: false }; let deltaCount = 0; const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let rsId = ""; let rsIndex = -1; let rsText = "";
  event(response, "response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [] } });
  try {
    const reader = upstream.body?.getReader(); if (!reader) throw new Error("Upstream returned no stream");
    const decoder = new TextDecoder(); let buffer = "";
    const consume = (line: string) => {
      if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
      try {
        const item = JSON.parse(value); const choice = item.choices?.[0]; const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta) { text += delta; deltaCount++; event(response, "response.output_text.delta", { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta }); }
        const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (typeof reasoningDelta === "string" && reasoningDelta) {
          if (!rsId) { rsId = `rs_${crypto.randomUUID()}`; rsIndex = REASONING_OUTPUT_INDEX;
            event(response, "response.output_item.added", { type: "response.output_item.added", output_index: rsIndex, item: { type: "reasoning", id: rsId, summary: [] } });
            event(response, "response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: rsId, output_index: rsIndex, summary_index: 0, part: { type: "summary_text", text: "" } });
          }
          rsText += reasoningDelta;
          event(response, "response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: rsId, output_index: rsIndex, summary_index: 0, delta: reasoningDelta });
        }
        for (const tool of choice?.delta?.tool_calls ?? []) {
          const index = tool.index ?? 0; const call = calls.get(index) ?? { id: tool.id ?? `call_${index}`, name: tool.function?.name ?? "", arguments: "" }; calls.set(index, call);
          if (tool.id || tool.function?.name) event(response, "response.output_item.added", { type: "response.output_item.added", output_index: index, item: { type: "function_call", call_id: call.id, name: call.name, arguments: "" } });
          if (tool.function?.arguments) { call.arguments += tool.function.arguments; event(response, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", call_id: call.id, delta: tool.function.arguments }); }
        }
        readChatUsage(item, usage);
      } catch { /* Ignore incomplete provider events. */ }
    };
    while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); if (done) break; }
  } finally { stopHeartbeat(); }
  const output: any[] = [];
  if (rsId) {
    event(response, "response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: rsId, output_index: rsIndex, summary_index: 0, text: rsText });
    event(response, "response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: rsId, output_index: rsIndex, summary_index: 0, part: { type: "summary_text", text: rsText } });
    event(response, "response.output_item.done", { type: "response.output_item.done", output_index: rsIndex, item: { type: "reasoning", id: rsId, summary: [{ type: "summary_text", text: rsText }] } });
    output.push({ type: "reasoning", id: rsId, summary: [{ type: "summary_text", text: rsText }] });
  }
  if (text) event(response, "response.output_text.done", { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text });
  if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  for (const call of calls.values()) { event(response, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", call_id: call.id, arguments: call.arguments }); output.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" }); }
  const details = usage.cached !== undefined || usage.reasoning !== undefined
    ? {
      ...(usage.cached !== undefined ? { input_tokens_details: { cached_tokens: usage.cached } } : {}),
      ...(usage.reasoning !== undefined ? { output_tokens_details: { reasoning_tokens: usage.reasoning } } : {})
    }
    : {};
  event(response, "response.completed", { type: "response.completed", response: { id, object: "response", status: "completed", model, output, usage: { input_tokens: usage.inputTokens, output_tokens: usage.sawUsage ? usage.outputTokens : deltaCount, ...details } } });
  response.write("data: [DONE]\n\n"); response.end();
  if (options?.onUsage) {
    const finalOutput = usage.sawUsage ? usage.outputTokens : deltaCount;
    options.onUsage(usage.sawUsage ? detailedUsage(options, usage.inputTokens, finalOutput, usage.cached, usage.reasoning) : estimatedUsage(options.provider, options.model, usage.inputTokens, finalOutput, options.sessionId));
  }
}

export async function pipeResponsesPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const stopHeartbeat = keepAlive(response);
  const reader = upstream.body?.getReader(); if (!reader) throw new Error("Upstream returned no stream");
  const decoder = new TextDecoder(); let buffer = ""; let usage: TokenUsage | null = null; let outputTokens = 0;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      if (item.type === "response.output_text.delta" && typeof item.delta === "string") outputTokens++;
      if (item.response?.usage && options) {
        const inputTokens = item.response.usage.input_tokens ?? 0;
        const totalOutput = item.response.usage.output_tokens ?? 0;
        const cached = item.response.usage.input_tokens_details?.cached_tokens;
        const reasoning = item.response.usage.output_tokens_details?.reasoning_tokens;
        usage = { provider: options.provider, model, inputTokens, outputTokens: totalOutput, totalTokens: item.response.usage.total_tokens ?? (inputTokens + totalOutput),
          ...(cached !== undefined && cached !== null ? { cachedInputTokens: Number(cached) } : {}),
          ...(reasoning !== undefined && reasoning !== null ? { reasoningTokens: Number(reasoning) } : {}),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}) };
      }
    } catch { /* Ignore incomplete provider events. */ }
  };
  try {
    while (true) { const { done, value } = await reader.read(); const chunk = value ? Buffer.from(decoder.decode(value, { stream: !done })) : Buffer.alloc(0); if (chunk.length) { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); response.write(chunk); } if (done) break; }
  } finally { stopHeartbeat(); }
  response.end();
  if (options?.onUsage) options.onUsage(usage ?? estimatedUsage(options.provider, model, 0, outputTokens, options.sessionId));
}

export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const stopHeartbeat = keepAlive(response);
  const id = `msg_${crypto.randomUUID()}`;
  event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const reader = upstream.body?.getReader();
  if (!reader) { stopHeartbeat(); throw new Error("Upstream returned no stream"); }
  const decoder = new TextDecoder(); let buffer = ""; const usage: UsageDetails = { inputTokens: 0, outputTokens: 0, sawUsage: false }; let blockIndex = 0; let blockStarted = false; let blockType: "text" | "tool_use" | "thinking" | undefined; let toolId = ""; let toolName = ""; let toolStop = false;
  const stopBlock = () => { if (blockStarted) { event(response, "content_block_stop", { type: "content_block_stop", index: blockIndex }); blockStarted = false; blockType = undefined; blockIndex++; } };
  const startBlock = (type: "text" | "thinking") => { if (blockStarted && blockType === type) return; stopBlock(); event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" } }); blockStarted = true; blockType = type; };
  const startTool = (tid: string, name: string) => { if (blockStarted && blockType !== "tool_use") stopBlock(); if (!blockStarted) { event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: tid, name, input: {} } }); blockStarted = true; blockType = "tool_use"; toolId = tid; toolName = name; toolStop = true; } };
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      const text = item.type === "response.output_text.delta"
        ? item.delta
        : item.choices?.[0]?.delta?.content;
      const reasoning = typeof (item.choices?.[0]?.delta?.reasoning_content ?? item.choices?.[0]?.delta?.reasoning) === "string"
        ? item.choices?.[0]?.delta?.reasoning_content ?? item.choices?.[0]?.delta?.reasoning
        : item.type === "response.reasoning_summary_text.delta" || item.type === "response.reasoning_text.delta"
          ? item.delta
          : undefined;
      if (typeof reasoning === "string" && reasoning) { startBlock("thinking"); event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "thinking_delta", thinking: reasoning } }); }
      if (typeof text === "string" && text) { startBlock("text"); usage.outputTokens++; event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } }); }
      const itemTool = item.type === "response.output_item.added" && item.item?.type === "function_call" ? item.item : undefined;
      const responseArgs = item.type === "response.function_call_arguments.delta" ? item.delta : undefined;
      const chatTool = item.choices?.[0]?.delta?.tool_calls?.[0];
      if (itemTool) startTool(itemTool.call_id ?? itemTool.id, itemTool.name ?? "");
      if (chatTool) { startTool(chatTool.id ?? toolId, chatTool.function?.name ?? toolName); if (chatTool.function?.arguments) event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: chatTool.function.arguments } }); }
      if (typeof responseArgs === "string") { startTool(item.call_id ?? item.item_id ?? toolId, item.name ?? toolName); event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: responseArgs } }); }
      readResponsesUsage(item, usage);
      readChatUsage(item, usage);
    } catch { /* Ignore comments and incomplete provider events. */ }
  };
  try {
    while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); if (done) break; }
  } finally { stopHeartbeat(); }
  if (!blockStarted) startBlock("text"); stopBlock();
  event(response, "message_delta", { type: "message_delta", delta: { stop_reason: toolStop ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.outputTokens, input_tokens: usage.inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: usage.cached ?? 0 } });
  event(response, "message_stop", { type: "message_stop" }); response.end();
  if (options?.onUsage) options.onUsage(usage.sawUsage ? detailedUsage(options, usage.inputTokens, usage.outputTokens, usage.cached, usage.reasoning) : estimatedUsage(options.provider, options.model, usage.inputTokens, usage.outputTokens, options.sessionId));
}

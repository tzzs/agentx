import type { ServerResponse } from "node:http";
import type { TokenUsage } from "./usage/types.js";

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };

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
  const id = `resp_${crypto.randomUUID()}`; let text = ""; let inputTokens = 0; let outputTokens = 0; let sawUsage = false; const calls = new Map<number, { id: string; name: string; arguments: string }>();
  event(response, "response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [] } });
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value); const choice = item.choices?.[0]; const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta) { text += delta; outputTokens++; event(response, "response.output_text.delta", { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta }); }
      for (const tool of choice?.delta?.tool_calls ?? []) {
        const index = tool.index ?? 0; const call = calls.get(index) ?? { id: tool.id ?? `call_${index}`, name: tool.function?.name ?? "", arguments: "" }; calls.set(index, call);
        if (tool.id || tool.function?.name) event(response, "response.output_item.added", { type: "response.output_item.added", output_index: index, item: { type: "function_call", call_id: call.id, name: call.name, arguments: "" } });
        if (tool.function?.arguments) { call.arguments += tool.function.arguments; event(response, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", call_id: call.id, delta: tool.function.arguments }); }
      }
      if (item.usage) { inputTokens = item.usage.prompt_tokens ?? inputTokens; outputTokens = item.usage.completion_tokens ?? outputTokens; sawUsage = true; }
    } catch { /* Ignore incomplete provider events. */ }
  };
  try {
    await drain(reader, consume);
    if (text) event(response, "response.output_text.done", { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text });
    const output: any[] = text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : [];
    for (const call of calls.values()) { event(response, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", call_id: call.id, arguments: call.arguments }); output.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" }); }
    event(response, "response.completed", { type: "response.completed", response: { id, object: "response", status: "completed", model, output, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
    response.write("data: [DONE]\n\n");
  } catch (error) {
    event(response, "response.failed", { type: "response.failed", response: { id, object: "response", status: "failed", model, error: { code: "upstream_error", message: errorMessage(error) } } });
  }
  response.end();
  reportUsage(options, sawUsage, inputTokens, outputTokens);
}

export async function pipeResponsesPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  let usage: TokenUsage | null = null; let outputTokens = 0;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      if (item.type === "response.output_text.delta" && typeof item.delta === "string") outputTokens++;
      if (item.response?.usage && options) { const inputTokens = item.response.usage.input_tokens ?? 0; const outputTokens = item.response.usage.output_tokens ?? 0; usage = { provider: options.provider, model, inputTokens, outputTokens, totalTokens: item.response.usage.total_tokens ?? (inputTokens + outputTokens), ...(options.sessionId ? { sessionId: options.sessionId } : {}) }; }
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
  reportUsage(options, usage !== null, (usage as TokenUsage | null)?.inputTokens ?? 0, (usage as TokenUsage | null)?.outputTokens ?? outputTokens);
}

export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  const id = `msg_${crypto.randomUUID()}`;
  event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let outputTokens = 0; let inputTokens = 0; let sawUsage = false; let blockIndex = 0; let blockStarted = false; let blockType: "text" | "tool_use" | undefined; let toolId = ""; let toolName = ""; let toolStop = false;
  const stopBlock = () => { if (blockStarted) { event(response, "content_block_stop", { type: "content_block_stop", index: blockIndex }); blockStarted = false; blockType = undefined; blockIndex++; } };
  const startText = () => { if (!blockStarted) { event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }); blockStarted = true; blockType = "text"; } };
  const startTool = (id: string, name: string) => { if (blockStarted && blockType !== "tool_use") stopBlock(); if (!blockStarted) { event(response, "content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id, name, input: {} } }); blockStarted = true; blockType = "tool_use"; toolId = id; toolName = name; toolStop = true; } };
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      const text = item.type === "response.output_text.delta"
        ? item.delta
        : item.choices?.[0]?.delta?.content;
      if (typeof text === "string" && text) { startText(); outputTokens++; event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } }); }
      const itemTool = item.type === "response.output_item.added" && item.item?.type === "function_call" ? item.item : undefined;
      const responseArgs = item.type === "response.function_call_arguments.delta" ? item.delta : undefined;
      const chatTool = item.choices?.[0]?.delta?.tool_calls?.[0];
      if (itemTool) startTool(itemTool.call_id ?? itemTool.id, itemTool.name ?? "");
      if (chatTool) { startTool(chatTool.id ?? toolId, chatTool.function?.name ?? toolName); if (chatTool.function?.arguments) event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: chatTool.function.arguments } }); }
      if (typeof responseArgs === "string") { startTool(item.call_id ?? item.item_id ?? toolId, item.name ?? toolName); event(response, "content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: responseArgs } }); }
      if (item.response?.usage) { inputTokens = item.response.usage.input_tokens ?? inputTokens; outputTokens = item.response.usage.output_tokens ?? outputTokens; sawUsage = true; }
    } catch { /* Ignore comments and incomplete provider events. */ }
  };
  try {
    await drain(reader, consume);
    if (!blockStarted) startText();
    stopBlock();
    event(response, "message_delta", { type: "message_delta", delta: { stop_reason: toolStop ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens } });
    event(response, "message_stop", { type: "message_stop" });
  } catch (error) {
    // Match Anthropic semantics: a terminal error event closes the stream.
    stopBlock();
    event(response, "error", { type: "error", error: { type: "api_error", message: errorMessage(error) } });
  }
  response.end();
  reportUsage(options, sawUsage, inputTokens, outputTokens);
}

function reportUsage(options: StreamUsageOptions | undefined, sawUsage: boolean, inputTokens: number, outputTokens: number) {
  if (!options?.onUsage) return;
  options.onUsage(sawUsage
    ? { provider: options.provider, model: options.model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }
    : estimatedUsage(options.provider, options.model, inputTokens, outputTokens, options.sessionId));
}

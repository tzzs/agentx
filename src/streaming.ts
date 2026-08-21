import type { ServerResponse } from "node:http";
import type { TokenUsage } from "./usage/types.js";

function event(response: ServerResponse, type: string, data: unknown) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
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

export async function pipeChatStreamToResponses(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `resp_${crypto.randomUUID()}`; let text = ""; let inputTokens = 0; let outputTokens = 0; let sawUsage = false; const calls = new Map<number, { id: string; name: string; arguments: string }>();
  event(response, "response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [] } });
  const reader = upstream.body?.getReader(); if (!reader) throw new Error("Upstream returned no stream");
  const decoder = new TextDecoder(); let buffer = "";
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
  while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); if (done) break; }
  if (text) event(response, "response.output_text.done", { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text });
  const output: any[] = text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : [];
  for (const call of calls.values()) { event(response, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", call_id: call.id, arguments: call.arguments }); output.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" }); }
  event(response, "response.completed", { type: "response.completed", response: { id, object: "response", status: "completed", model, output, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
  response.write("data: [DONE]\n\n"); response.end();
  if (options?.onUsage) options.onUsage(sawUsage ? { provider: options.provider, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(options.sessionId ? { sessionId: options.sessionId } : {}) } : estimatedUsage(options.provider, model, inputTokens, outputTokens, options.sessionId));
}

export async function pipeResponsesPassthrough(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const reader = upstream.body?.getReader(); if (!reader) throw new Error("Upstream returned no stream");
  const decoder = new TextDecoder(); let buffer = ""; let usage: TokenUsage | null = null; let outputTokens = 0;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value);
      if (item.type === "response.output_text.delta" && typeof item.delta === "string") outputTokens++;
      if (item.response?.usage && options) { const inputTokens = item.response.usage.input_tokens ?? 0; const outputTokens = item.response.usage.output_tokens ?? 0; usage = { provider: options.provider, model, inputTokens, outputTokens, totalTokens: item.response.usage.total_tokens ?? (inputTokens + outputTokens), ...(options.sessionId ? { sessionId: options.sessionId } : {}) }; }
    } catch { /* Ignore incomplete provider events. */ }
  };
  while (true) { const { done, value } = await reader.read(); const chunk = value ? Buffer.from(decoder.decode(value, { stream: !done })) : Buffer.alloc(0); if (chunk.length) { buffer += chunk.toString(); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); response.write(chunk); } if (done) break; }
  response.end();
  if (options?.onUsage) options.onUsage(usage ?? estimatedUsage(options.provider, model, 0, outputTokens, options.sessionId));
}

export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `msg_${crypto.randomUUID()}`;
  event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  const decoder = new TextDecoder(); let buffer = ""; let outputTokens = 0; let inputTokens = 0; let sawUsage = false; let blockIndex = 0; let blockStarted = false; let blockType: "text" | "tool_use" | undefined; let toolId = ""; let toolName = ""; let toolStop = false;
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
  while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); if (done) break; }
  if (!blockStarted) startText(); stopBlock();
  event(response, "message_delta", { type: "message_delta", delta: { stop_reason: toolStop ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens } });
  event(response, "message_stop", { type: "message_stop" }); response.end();
  if (options?.onUsage) options.onUsage(sawUsage ? { provider: options.provider, model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...(options.sessionId ? { sessionId: options.sessionId } : {}) } : estimatedUsage(options.provider, model, inputTokens, outputTokens, options.sessionId));
}

import type { ServerResponse } from "node:http";

function event(response: ServerResponse, type: string, data: unknown) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `msg_${crypto.randomUUID()}`;
  event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  const decoder = new TextDecoder(); let buffer = ""; let outputTokens = 0; let inputTokens = 0; let blockIndex = 0; let blockStarted = false; let blockType: "text" | "tool_use" | undefined; let toolId = ""; let toolName = ""; let toolStop = false;
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
      if (item.response?.usage) { inputTokens = item.response.usage.input_tokens ?? inputTokens; outputTokens = item.response.usage.output_tokens ?? outputTokens; }
    } catch { /* Ignore comments and incomplete provider events. */ }
  };
  while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); if (done) break; }
  if (!blockStarted) startText(); stopBlock();
  event(response, "message_delta", { type: "message_delta", delta: { stop_reason: toolStop ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens } });
  event(response, "message_stop", { type: "message_stop" }); response.end();
}

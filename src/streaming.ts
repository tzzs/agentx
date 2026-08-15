import type { ServerResponse } from "node:http";

function event(response: ServerResponse, type: string, data: unknown) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function pipeResponsesStream(upstream: Response, response: ServerResponse, model: string) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `msg_${crypto.randomUUID()}`;
  event(response, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  event(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  const decoder = new TextDecoder(); let buffer = ""; let outputTokens = 0; let inputTokens = 0;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).trim(); if (!value || value === "[DONE]") return;
    try {
      const item = JSON.parse(value); const delta = item.delta ?? item;
      const text = delta?.text ?? (item.type === "response.output_text.delta" ? item.delta : undefined);
      if (typeof text === "string" && text) { outputTokens++; event(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }); }
      if (item.response?.usage) { inputTokens = item.response.usage.input_tokens ?? inputTokens; outputTokens = item.response.usage.output_tokens ?? outputTokens; }
    } catch { /* Ignore comments and incomplete provider events. */ }
  };
  while (true) { const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume); if (done) break; }
  event(response, "content_block_stop", { type: "content_block_stop", index: 0 });
  event(response, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens } });
  event(response, "message_stop", { type: "message_stop" }); response.end();
}

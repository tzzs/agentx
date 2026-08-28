import type { ServerResponse } from "node:http";
import { cancelOnDisconnect, drain, errorMessage, event, REASONING_OUTPUT_INDEX, reportUsage, SSE_HEADERS, startHeartbeat, UpstreamFailure, type StreamUsageOptions } from "./common.js";

/**
 * Pipe a native Anthropic Messages SSE stream into Codex-style Responses
 * events. Used for Codex (or any other Responses-facing client) reaching a
 * custom provider whose protocol is "anthropic" — mirrors
 * `pipeChatStreamToResponses`'s role for a Chat Completions upstream, just
 * parsing Anthropic's `content_block_*`/`message_*` event grammar instead.
 * Anthropic's content block `index` is reused directly as the Responses
 * `output_index` for tool calls, since Anthropic already hands out stable
 * per-block indices.
 */
export async function pipeAnthropicStreamToResponses(upstream: Response, response: ServerResponse, model: string, options?: StreamUsageOptions) {
  const reader = upstream.body?.getReader();
  if (!reader) throw new Error("Upstream returned no stream");
  cancelOnDisconnect(response, reader);
  response.writeHead(200, SSE_HEADERS);
  // try/finally guarantees the interval is cleared even if a write to the
  // local client throws.
  const stopHeartbeat = startHeartbeat(response);
  try {
  const id = `resp_${crypto.randomUUID()}`; const msgId = `msg_${crypto.randomUUID()}`;
  let text = ""; let inputTokens = 0; let outputTokens = 0; let sawUsage = false; let truncated = false; let lastUsage: any;
  let rsId = ""; let rsText = ""; let messageAnnounced = false;
  // A native Anthropic upstream must close every turn with message_stop;
  // seeing neither it nor an in-band error means the connection dropped
  // mid-turn and must not read back as a normal "completed" response.
  let sawMessageStop = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  event(response, "response.created", { type: "response.created", response: { id, object: "response", status: "in_progress", model, output: [] } });
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return; const value = line.slice(5).trim(); if (!value) return;
    try {
      const item = JSON.parse(value);
      if (item.type === "error") throw new UpstreamFailure(item.error?.message ?? "Upstream stream failed");
      if (item.type === "message_start" && item.message?.usage) {
        inputTokens = item.message.usage.input_tokens ?? inputTokens;
        outputTokens = item.message.usage.output_tokens ?? outputTokens;
      }
      if (item.type === "content_block_start") {
        const blockType = item.content_block?.type;
        if (blockType === "tool_use") {
          const call = { id: item.content_block.id ?? `call_${item.index}`, name: item.content_block.name ?? "", arguments: "" };
          calls.set(item.index, call);
          event(response, "response.output_item.added", { type: "response.output_item.added", output_index: item.index, item: { type: "function_call", id: `fc_${item.index}`, call_id: call.id, name: call.name, arguments: "", status: "in_progress" } });
        } else if (blockType === "thinking" && !rsId) {
          rsId = `rs_${crypto.randomUUID()}`;
          event(response, "response.output_item.added", { type: "response.output_item.added", output_index: REASONING_OUTPUT_INDEX, item: { type: "reasoning", id: rsId, summary: [] } });
          event(response, "response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, part: { type: "summary_text", text: "" } });
        }
      }
      if (item.type === "content_block_delta") {
        const delta = item.delta ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (!messageAnnounced) {
            messageAnnounced = true;
            event(response, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: msgId, role: "assistant", status: "in_progress", content: [] } });
          }
          text += delta.text; outputTokens++;
          event(response, "response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: 0, content_index: 0, delta: delta.text });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          rsText += delta.thinking;
          event(response, "response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, delta: delta.thinking });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const call = calls.get(item.index);
          if (call) {
            call.arguments += delta.partial_json;
            event(response, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: `fc_${item.index}`, output_index: item.index, call_id: call.id, delta: delta.partial_json });
          }
        }
      }
      if (item.type === "message_delta") {
        if (item.delta?.stop_reason === "max_tokens") truncated = true;
        if (item.usage) { outputTokens = item.usage.output_tokens ?? outputTokens; lastUsage = item.usage; sawUsage = true; }
      }
      if (item.type === "message_stop") sawMessageStop = true;
    } catch (error) {
      // In-band upstream failures must end the stream; only parse noise is ignored.
      if (error instanceof UpstreamFailure) throw error;
    }
  };
  try {
    await drain(reader, consume);
    if (!sawMessageStop) {
      const message = "Upstream Anthropic stream ended before message_stop was received.";
      options?.onDiagnostic?.(message);
      throw new UpstreamFailure(message);
    }
    if (rsId) {
      event(response, "response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, text: rsText });
      event(response, "response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: rsId, output_index: REASONING_OUTPUT_INDEX, summary_index: 0, part: { type: "summary_text", text: rsText } });
      event(response, "response.output_item.done", { type: "response.output_item.done", output_index: REASONING_OUTPUT_INDEX, item: { type: "reasoning", id: rsId, summary: [{ type: "summary_text", text: rsText }] } });
    }
    if (text) {
      event(response, "response.output_text.done", { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text });
      // Codex collects turn items from output_item.done; the message must be
      // finalized there or only the reasoning/tool items reach the client.
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

import { cancelOnDisconnect, drain, errorMessage, event, failureMessage, REASONING_OUTPUT_INDEX, reasoningDeltaOf, reportUsage, SSE_HEADERS, startHeartbeat, UpstreamFailure, type StreamUsageOptions } from "./common.js";

/**
 * Pipe a Chat Completions SSE upstream into Codex-style Responses events. Used
 * for non-OpenCode providers that still speak the legacy chat protocol.
 */
export async function pipeChatStreamToResponses(upstream: Response, response: import("node:http").ServerResponse, model: string, options?: StreamUsageOptions) {
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

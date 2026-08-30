/** Anthropic Messages API <-> Responses API: the direction whose upstream speaks the Responses protocol. */
import type { AnthropicMessage, AnthropicRequest } from "./shared.js";
import { chatThinking, imageDataUri, parse, reasoningEffort, responsesToolChoice } from "./shared.js";
import { fromAnthropicResponseToChat, toAnthropicRequestFromChat } from "./anthropic.js";

function convertContent(content: any, role: string): any {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "text") return { type: role === "assistant" ? "output_text" : "input_text", text: part.text ?? "" };
    if (part.type === "image") { const url = imageDataUri(part.source); return url ? { type: "input_image", image_url: url } : null; }
    if (part.type === "tool_result") return { type: "function_call_output", call_id: part.tool_use_id, output: typeof part.content === "string" ? part.content : JSON.stringify(part.content) };
    if (part.type === "tool_use") return { type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) };
    return part;
  }).filter((part) => part !== null);
}

export function toResponsesRequest(input: AnthropicRequest, model: string): Record<string, unknown> {
  const thinking = chatThinking(input);
  const effort = reasoningEffort(input);
  const toolChoice = responsesToolChoice(input.tool_choice);
  const body: Record<string, unknown> = {
    model, input: toResponsesInput(input.messages),
    ...(input.max_tokens === undefined ? {} : { max_output_tokens: input.max_tokens }),
    ...(input.stream ? { stream: true } : {}),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { top_p: input.top_p }),
    ...(thinking?.type === "disabled" ? { reasoning: { effort: "none" } } : effort ? { reasoning: { effort } } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice })
  };
  if (input.tools) body.tools = input.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema }));
  if (input.system !== undefined) {
    body.instructions = typeof input.system === "string"
      ? input.system
      : input.system.map((part) => part.text ?? "").join("\n");
  }
  return body;
}

/** Thinking blocks are local-only reasoning echoes from Claude Code; upstream providers never accept them. */
function isThinkingPart(part: any): boolean { return part?.type === "thinking" || part?.type === "redacted_thinking"; }

function toResponsesInput(messages: AnthropicMessage[]): any[] {
  const output: any[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { output.push({ ...message, content: convertContent(message.content, message.role) }); continue; }
    const textParts: any[] = [];
    for (const part of message.content as any[]) {
      if (isThinkingPart(part)) continue;
      if (part.type === "tool_use") { output.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) }); continue; }
      if (part.type === "tool_result") { output.push({ type: "function_call_output", call_id: part.tool_use_id, output: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "") }); continue; }
      const converted = convertContent([part], message.role)[0]; if (converted) textParts.push(converted);
    }
    if (textParts.length) output.push({ role: message.role, content: textParts });
  }
  return output;
}

function reasoningText(output: any[]): string {
  return (output ?? [])
    .filter((item: any) => item.type === "reasoning")
    .flatMap((item: any) => [
      ...(item.summary ?? []).map((part: any) => part.text ?? ""),
      ...(item.content ?? []).filter((part: any) => part.type === "reasoning_text").map((part: any) => part.text ?? "")
    ])
    .join("");
}

export function fromResponsesResponse(response: any, model: string): Record<string, unknown> {
  const output = response.output ?? [];
  const text = output
    .filter((item: any) => item.type === "message")
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part.type === "output_text")
    .map((part: any) => part.text ?? "").join("");
  const toolUses = output.filter((item: any) => item.type === "function_call").map((item: any) => ({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: parse(item.arguments) }));
  const thinking = reasoningText(output);
  return {
    id: response.id ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model,
    content: [...(thinking ? [{ type: "thinking", thinking }] : []), ...(text ? [{ type: "text", text }] : []), ...toolUses],
    stop_reason: toolUses.length ? "tool_use" : response.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0
    }
  };
}

/** Return a failure for a Responses result that must not look like a turn end. */
export function responsesResponseFailure(response: any): string | undefined {
  if (response?.status === "failed") {
    return response.error?.message ?? response.error ?? "The upstream response failed.";
  }
  if (response?.status === "incomplete" && response.incomplete_details?.reason !== "max_output_tokens") {
    return `The upstream response is incomplete (${String(response.incomplete_details?.reason ?? "unknown")}).`;
  }
  return undefined;
}

/**
 * Chat Completions <-> Responses API: the local `/v1/chat/completions`
 * endpoint reaching an upstream whose protocol is "responses". Reuses
 * `toAnthropicRequestFromChat`/`toResponsesRequest` instead of writing a
 * separate chat->Responses request mapping.
 */
export function toResponsesRequestFromChat(input: any, model: string): Record<string, unknown> {
  return toResponsesRequest(toAnthropicRequestFromChat(input, model) as unknown as AnthropicRequest, model);
}

/** Reuses `fromResponsesResponse`/`fromAnthropicResponseToChat` instead of writing a separate Responses->chat response mapping. */
export function fromResponsesResponseToChat(response: any, model: string): Record<string, unknown> {
  return fromAnthropicResponseToChat(fromResponsesResponse(response, model), model);
}

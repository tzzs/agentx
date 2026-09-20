/**
 * Anthropic Messages API <-> Chat Completions, and Responses API <-> Chat
 * Completions: every conversion direction whose upstream speaks the Chat
 * Completions protocol.
 */
import type { AnthropicMessage, AnthropicRequest } from "./shared.js";
import type { JsonRecord, JsonValue } from "../json.js";
import { isRecord, parse, recNum, recObj, recObjs, recStr } from "../json.js";
import { chatControlParams, collapseAnthropicContent, imageDataUri, samplingParams } from "./shared.js";
import { isDeepSeekLongContextModel } from "../providers/registry.js";

/** One Chat Completions message as sent upstream (or received back). */
type ChatMessage = JsonRecord;

export function toChatRequest(input: AnthropicRequest, model: string, provider?: string) {
  const messages: ChatMessage[] = [];
  if (input.system) messages.push({ role: "system", content: typeof input.system === "string" ? input.system : input.system.map((part) => part.text ?? "").join("\n") });
  const deepSeek = provider === "deepseek" || isDeepSeekLongContextModel(model);
  for (const message of input.messages) messages.push(...toChatMessages(message, deepSeek));
  return { model, messages, ...(input.max_tokens === undefined ? {} : { max_tokens: input.max_tokens }), ...(input.stream ? { stream: true } : {}), ...samplingParams(input), ...chatControlParams(input, deepSeek), ...(input.tools ? { tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}) };
}

function toChatImagePart(part: JsonRecord | undefined): ChatMessage | undefined {
  const url = imageDataUri(recObj(part, "source"));
  return url ? { type: "image_url", image_url: { url } } : undefined;
}

function toChatMessages(message: AnthropicMessage, preserveReasoning = false): ChatMessage[] {
  if (!Array.isArray(message.content)) return [{ role: message.role, content: message.content ?? "" }];
  const parts: ChatMessage[] = [];
  const toolCalls: ChatMessage[] = [];
  const toolResults: ChatMessage[] = [];
  let reasoning = "";
  const pushText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.type === "text") last.text = `${recStr(last, "text") ?? ""}${text}`;
    else parts.push({ type: "text", text });
  };
  for (const raw of message.content) {
    if (!isRecord(raw)) continue;
    const part = raw;
    if (part.type === "tool_use") {
      toolCalls.push({ id: recStr(part, "id"), type: "function", function: { name: recStr(part, "name"), arguments: JSON.stringify(part.input ?? {}) } });
    } else if (part.type === "tool_result") {
      toolResults.push({ role: "tool", tool_call_id: part.tool_use_id, content: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "") });
    } else if (part.type === "text") {
      pushText(recStr(part, "text") ?? "");
    } else if (part.type === "thinking" && preserveReasoning && message.role === "assistant") {
      const thinking = recStr(part, "thinking");
      if (thinking) reasoning += thinking;
    } else if (part.type === "image") {
      const image = toChatImagePart(part);
      if (image) parts.push(image);
    }
  }
  const output: ChatMessage[] = [];
  if (message.role === "assistant" && (parts.length || toolCalls.length || reasoning)) {
    output.push({
      role: "assistant",
      content: parts.length ? collapseAnthropicContent(parts) : null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  } else if (parts.length) {
    output.push({ role: message.role, content: collapseAnthropicContent(parts) });
  }
  output.push(...toolResults);
  return output;
}
/** Plain text of a chat message content, ignoring non-text parts (images etc.). */
function chatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(isRecord).filter((part) => part.type === "text").map((part) => recStr(part, "text") ?? "").join("");
  return "";
}

/** Nested usage details of a Chat Completions response (`prompt_tokens_details`, …). */
function chatUsageDetails(response: JsonRecord, usageKey: string, detailKey: string, field: string): number | undefined {
  return recNum(recObj(recObj(response, usageKey), detailKey), field);
}

export function fromChatResponse(response: JsonRecord, model: string): JsonRecord {
  const choice = recObjs(response, "choices")[0] ?? {}; const message = recObj(choice, "message") ?? {}; const content: JsonRecord[] = [];
  const reasoningContent = recStr(message, "reasoning_content");
  if (reasoningContent) content.push({ type: "thinking", thinking: reasoningContent });
  const text = chatText(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of recObjs(message, "tool_calls")) content.push({ type: "tool_use", id: recStr(call, "id"), name: recStr(recObj(call, "function"), "name"), input: parse(recStr(recObj(call, "function"), "arguments")) });
  const finishReason = choice.finish_reason;
  const usage = recObj(response, "usage");
  const toolCallCount = recObjs(message, "tool_calls").length;
  return { id: recStr(response, "id") ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: toolCallCount ? "tool_use" : finishReason === "length" ? "max_tokens" : finishReason === "stop" || finishReason === undefined ? "end_turn" : "max_tokens", stop_sequence: null, usage: { input_tokens: recNum(usage, "prompt_tokens") ?? 0, output_tokens: recNum(usage, "completion_tokens") ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: chatUsageDetails(response, "usage", "prompt_tokens_details", "cached_tokens") ?? 0 } };
}

/** Return a failure for a provider completion that is not a normal stop. */
export function chatResponseFailure(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const reason = recObjs(response, "choices")[0]?.finish_reason;
  if (reason === undefined || reason === null || reason === "stop" || reason === "length" || reason === "tool_calls" || reason === "function_call") return undefined;
  if (reason === "insufficient_system_resource") return "The upstream model stopped because inference resources were insufficient.";
  if (reason === "content_filter") return "The upstream model stopped because the response was filtered.";
  return `The upstream model stopped with finish_reason=${String(reason)}.`;
}

/**
 * Flatten Responses-API tool definitions into Chat Completions function
 * tools. Namespace containers (e.g. Codex multi-agent) are unwrapped so their
 * nested functions survive; server-side built-ins (`web_search`, `local_shell`,
 * custom grammar tools…) have no chat-completions representation and must be
 * dropped rather than forwarded as nameless function entries, which strict
 * upstreams reject as invalid parameters.
 */
function toChatTools(tools: unknown): JsonRecord[] {
  return Array.isArray(tools) ? tools.flatMap((raw: unknown) => {
    if (!isRecord(raw)) return [];
    if (Array.isArray(raw.tools)) return toChatTools(raw.tools);
    // Server-side built-ins (typed, no nested function) have no chat
    // representation; everything else must resolve to a named function.
    if (raw.type !== undefined && raw.type !== "function" && !raw.function) return [];
    const source = recObj(raw, "function") ?? raw;
    const name = recStr(source, "name");
    if (!name) return [];
    return [{ type: "function", function: { name, ...(source.description === undefined ? {} : { description: source.description }), ...(source.parameters === undefined ? {} : { parameters: source.parameters }) } }];
  }) : [];
}

export function toChatCompletionsRequest(input: JsonRecord, model: string, provider?: string) {
  const messages: ChatMessage[] = [];
  const instructions = recStr(input, "instructions");
  if (instructions) messages.push({ role: "system", content: instructions });
  const rawInput = input.input;
  const items: JsonRecord[] = typeof rawInput === "string" ? [{ role: "user", content: rawInput }] : Array.isArray(rawInput) ? rawInput.filter(isRecord) : [];
  // reasoning_content is a DeepSeek-specific extension; forwarding it to other
  // chat-completions upstreams risks a strict schema rejecting the request.
  const deepSeek = provider === "deepseek" || isDeepSeekLongContextModel(model);
  let pendingReasoning = "";
  for (const item of items) {
    if (item.type === "reasoning") {
      if (deepSeek) pendingReasoning += responseReasoningText(item);
    } else if (item.type === "function_call") {
      const call = { id: recStr(item, "call_id") ?? recStr(item, "id"), type: "function", function: { name: recStr(item, "name"), arguments: recStr(item, "arguments") ?? "{}" } };
      messages.push({ role: "assistant", content: null, ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}), tool_calls: [call] });
      pendingReasoning = "";
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
    } else if (typeof item.role === "string") {
      const role = item.role === "developer" ? "system" : item.role;
      messages.push({ role, content: responseContent(item.content), ...(role === "assistant" && pendingReasoning ? { reasoning_content: pendingReasoning } : {}) });
      pendingReasoning = "";
    }
  }
  if (pendingReasoning) messages.push({ role: "assistant", content: null, reasoning_content: pendingReasoning });
  const tools = toChatTools(input.tools);
  return { model, messages, ...(input.max_output_tokens === undefined ? {} : { max_tokens: input.max_output_tokens }), ...(input.stream ? { stream: true } : {}), ...samplingParams(input), ...chatControlParams(input, deepSeek), ...(tools.length ? { tools } : {}) };
}

function responseReasoningText(item: JsonRecord): string {
  return recObjs(item, "summary")
    .filter((part) => part.type === "summary_text" && typeof part.text === "string")
    .map((part) => recStr(part, "text") ?? "")
    .join("");
}

export function fromChatResponseToResponses(response: JsonRecord, model: string): JsonRecord {
  const choice = recObjs(response, "choices")[0] ?? {}; const message = recObj(choice, "message") ?? {}; const output: JsonRecord[] = [];
  const reasoningContent = recStr(message, "reasoning_content");
  if (reasoningContent) output.push({ type: "reasoning", id: `rs_${crypto.randomUUID()}`, summary: [{ type: "summary_text", text: reasoningContent }] });
  const text = chatText(message.content);
  if (text) output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
  for (const call of recObjs(message, "tool_calls")) output.push({ type: "function_call", call_id: recStr(call, "id"), name: recStr(recObj(call, "function"), "name"), arguments: recStr(recObj(call, "function"), "arguments") ?? "{}", status: "completed" });
  const usage = recObj(response, "usage");
  const cached = chatUsageDetails(response, "usage", "prompt_tokens_details", "cached_tokens");
  const reasoningTokens = chatUsageDetails(response, "usage", "completion_tokens_details", "reasoning_tokens");
  const incomplete = choice.finish_reason === "length";
  return { id: recStr(response, "id") ?? `resp_${crypto.randomUUID()}`, object: "response", status: incomplete ? "incomplete" : "completed", model, output, usage: { input_tokens: recNum(usage, "prompt_tokens") ?? 0, output_tokens: recNum(usage, "completion_tokens") ?? 0, total_tokens: recNum(usage, "total_tokens") ?? 0, ...(cached !== undefined ? { input_tokens_details: { cached_tokens: Number(cached) } } : {}), ...(reasoningTokens !== undefined ? { output_tokens_details: { reasoning_tokens: Number(reasoningTokens) } } : {}) }, ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}) };
}

function responseContent(content: JsonValue): JsonValue {
  if (!Array.isArray(content)) return content ?? "";
  const parts: JsonRecord[] = [];
  for (const raw of content) {
    // Bare strings are the common shorthand for a text part.
    if (typeof raw === "string") { if (raw) parts.push({ type: "text", text: raw }); continue; }
    if (!isRecord(raw)) continue;
    const text = recStr(raw, "text") ?? "";
    if (raw.type === "input_text" || raw.type === "output_text") { if (text) parts.push({ type: "text", text }); continue; }
    const url = recStr(raw, "image_url");
    if (raw.type === "input_image" && url) { parts.push({ type: "image_url", image_url: { url } }); continue; }
    parts.push(raw);
  }
  return collapseAnthropicContent(parts);
}

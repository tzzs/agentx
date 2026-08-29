/**
 * Anthropic Messages API <-> Chat Completions, and Responses API <-> Chat
 * Completions: every conversion direction whose upstream speaks the Chat
 * Completions protocol.
 */
import type { AnthropicMessage, AnthropicRequest } from "./shared.js";
import { chatControlParams, imageDataUri, parse, samplingParams } from "./shared.js";

function isDeepSeekModel(model: string): boolean {
  return /(?:^|\/)deepseek-v4-(?:flash|pro)(?:\[1m\])?$/.test(model);
}

export function toChatRequest(input: AnthropicRequest, model: string, provider?: string) {
  const messages: any[] = [];
  if (input.system) messages.push({ role: "system", content: typeof input.system === "string" ? input.system : input.system.map((part) => part.text ?? "").join("\n") });
  const deepSeek = provider === "deepseek" || isDeepSeekModel(model);
  for (const message of input.messages) messages.push(...toChatMessages(message, deepSeek));
  return { model, messages, ...(input.max_tokens === undefined ? {} : { max_tokens: input.max_tokens }), ...(input.stream ? { stream: true } : {}), ...samplingParams(input as any), ...chatControlParams(input, deepSeek), ...(input.tools ? { tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}) };
}

function toChatImagePart(part: any): any | undefined {
  const url = imageDataUri(part?.source);
  return url ? { type: "image_url", image_url: { url } } : undefined;
}

function toChatMessages(message: AnthropicMessage, preserveReasoning = false): any[] {
  if (!Array.isArray(message.content)) return [{ role: message.role, content: message.content ?? "" }];
  const parts: any[] = [];
  const toolCalls: any[] = [];
  const toolResults: any[] = [];
  let reasoning = "";
  const pushText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.type === "text") last.text += text;
    else parts.push({ type: "text", text });
  };
  for (const part of message.content) {
    if (part.type === "tool_use") {
      toolCalls.push({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
    } else if (part.type === "tool_result") {
      toolResults.push({ role: "tool", tool_call_id: part.tool_use_id, content: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "") });
    } else if (part.type === "text") {
      pushText(part.text ?? "");
    } else if (part.type === "thinking" && preserveReasoning && message.role === "assistant") {
      if (typeof part.thinking === "string") reasoning += part.thinking;
    } else if (part.type === "image") {
      const image = toChatImagePart(part);
      if (image) parts.push(image);
    }
  }
  const output: any[] = [];
  if (message.role === "assistant" && (parts.length || toolCalls.length || reasoning)) {
    const assistant: any = {
      role: "assistant",
      content: parts.length
        ? parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("") : parts
        : null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    output.push(assistant);
  } else if (parts.length) {
    output.push({ role: message.role, content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("") : parts });
  }
  output.push(...toolResults);
  return output;
}
/** Plain text of a chat message content, ignoring non-text parts (images etc.). */
function chatText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
  return "";
}

export function fromChatResponse(response: any, model: string): Record<string, unknown> {
  const choice = response.choices?.[0] ?? {}; const message = choice.message ?? {}; const content = [];
  if (message.reasoning_content) content.push({ type: "thinking", thinking: message.reasoning_content });
  const text = chatText(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function?.name, input: parse(call.function?.arguments) });
  const finishReason = choice.finish_reason;
  return { id: response.id ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: message.tool_calls?.length ? "tool_use" : finishReason === "length" ? "max_tokens" : finishReason === "stop" || finishReason === undefined ? "end_turn" : "max_tokens", stop_sequence: null, usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0 } };
}

/** Return a failure for a provider completion that is not a normal stop. */
export function chatResponseFailure(response: any): string | undefined {
  const reason = response?.choices?.[0]?.finish_reason;
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
function toChatTools(tools: unknown): any[] {
  return Array.isArray(tools) ? tools.flatMap((tool: any) => {
    if (Array.isArray(tool?.tools)) return toChatTools(tool.tools);
    // Server-side built-ins (typed, no nested function) have no chat
    // representation; everything else must resolve to a named function.
    if (tool?.type !== undefined && tool.type !== "function" && !tool.function) return [];
    const source = tool?.function ?? tool;
    if (!source || typeof source.name !== "string" || !source.name) return [];
    return [{ type: "function", function: { name: source.name, ...(source.description === undefined ? {} : { description: source.description }), ...(source.parameters === undefined ? {} : { parameters: source.parameters }) } }];
  }) : [];
}

export function toChatCompletionsRequest(input: any, model: string, provider?: string) {
  const messages: any[] = [];
  if (input.instructions) messages.push({ role: "system", content: input.instructions });
  const items = typeof input.input === "string" ? [{ role: "user", content: input.input }] : input.input ?? [];
  // reasoning_content is a DeepSeek-specific extension; forwarding it to other
  // chat-completions upstreams risks a strict schema rejecting the request.
  const deepSeek = provider === "deepseek" || isDeepSeekModel(model);
  let pendingReasoning = "";
  for (const item of items) {
    if (item.type === "reasoning") {
      if (deepSeek) pendingReasoning += responseReasoningText(item);
    } else if (item.type === "function_call") {
      const call = { id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } };
      messages.push({ role: "assistant", content: null, ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}), tool_calls: [call] });
      pendingReasoning = "";
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
    } else if (item.role) {
      const role = item.role === "developer" ? "system" : item.role;
      messages.push({ role, content: responseContent(item.content), ...(role === "assistant" && pendingReasoning ? { reasoning_content: pendingReasoning } : {}) });
      pendingReasoning = "";
    }
  }
  if (pendingReasoning) messages.push({ role: "assistant", content: null, reasoning_content: pendingReasoning });
  const tools = toChatTools(input.tools);
  return { model, messages, ...(input.max_output_tokens === undefined ? {} : { max_tokens: input.max_output_tokens }), ...(input.stream ? { stream: true } : {}), ...samplingParams(input), ...chatControlParams(input, deepSeek), ...(tools.length ? { tools } : {}) };
}

function responseReasoningText(item: any): string {
  return (item.summary ?? [])
    .filter((part: any) => part?.type === "summary_text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

export function fromChatResponseToResponses(response: any, model: string): Record<string, unknown> {
  const choice = response.choices?.[0] ?? {}; const message = choice.message ?? {}; const output: any[] = [];
  if (message.reasoning_content) output.push({ type: "reasoning", id: `rs_${crypto.randomUUID()}`, summary: [{ type: "summary_text", text: message.reasoning_content }] });
  const text = chatText(message.content);
  if (text) output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
  for (const call of message.tool_calls ?? []) output.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? "{}", status: "completed" });
  const cached = response.usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens;
  const incomplete = choice.finish_reason === "length";
  return { id: response.id ?? `resp_${crypto.randomUUID()}`, object: "response", status: incomplete ? "incomplete" : "completed", model, output, usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0, total_tokens: response.usage?.total_tokens ?? 0, ...(cached !== undefined && cached !== null ? { input_tokens_details: { cached_tokens: Number(cached) } } : {}), ...(reasoning !== undefined && reasoning !== null ? { output_tokens_details: { reasoning_tokens: Number(reasoning) } } : {}) }, ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}) };
}

function responseContent(content: any): any {
  if (!Array.isArray(content)) return content ?? "";
  const parts = content.map((part) => {
    if (part == null || part === "") return undefined;
    if (part.type === "input_text" || part.type === "output_text") return part.text ?? "" ? { type: "text", text: part.text ?? "" } : undefined;
    if (part.type === "input_image" && part.image_url) return { type: "image_url", image_url: { url: part.image_url } };
    return typeof part === "string" ? { type: "text", text: part } : part;
  }).filter((part) => part !== undefined);
  if (!parts.length) return "";
  // Plain text stays a string; anything structured keeps the content array.
  return parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("") : parts;
}

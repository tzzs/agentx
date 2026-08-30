/**
 * Responses API <-> Anthropic Messages API: a custom provider can speak
 * native Anthropic Messages API, and Codex (which only ever sees the local
 * Responses endpoint) still needs to reach it. Unlike responses.ts, here the
 * upstream is Anthropic-shaped.
 */
import type { AnthropicMessage, AnthropicThinking } from "./shared.js";
import { anthropicThinking, anthropicToolChoice, parse } from "./shared.js";

/** Build an Anthropic image content block from a Responses `input_image.image_url`, which may be a real URL or a data: URI. */
function toAnthropicImageSource(url: string): { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } | undefined {
  const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (dataMatch) return { type: "base64", media_type: dataMatch[1], data: dataMatch[2] };
  return url ? { type: "url", url } : undefined;
}

/** Responses message content (string or input_text/input_image parts) to Anthropic message content. */
function toAnthropicContent(content: any): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content.map((part: any) => {
    if (part?.type === "input_text" || part?.type === "output_text") return part.text ? { type: "text", text: part.text } : undefined;
    if (part?.type === "input_image" && typeof part.image_url === "string") { const source = toAnthropicImageSource(part.image_url); return source ? { type: "image", source } : undefined; }
    return undefined;
  }).filter((part: any) => part !== undefined);
  if (!parts.length) return "";
  return parts.every((part: any) => part.type === "text") ? parts.map((part: any) => part.text).join("") : parts;
}

/** Plain text of a Responses message item's content, ignoring non-text parts. */
function responsesItemText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "output_text" || part?.type === "input_text").map((part: any) => part.text ?? "").join("");
}

export function toAnthropicRequest(input: any, model: string): Record<string, unknown> {
  const items = typeof input.input === "string" ? [{ role: "user", content: input.input }] : input.input ?? [];
  const messages: AnthropicMessage[] = [];
  // Responses represents one assistant turn as separate top-level items
  // (a message item for text, a function_call item per tool call); Anthropic
  // wants them merged back into one assistant message's content blocks.
  let pendingAssistantBlocks: any[] = [];
  const flushAssistant = () => { if (pendingAssistantBlocks.length) { messages.push({ role: "assistant", content: pendingAssistantBlocks }); pendingAssistantBlocks = []; } };
  for (const item of items) {
    if (item.type === "reasoning") continue; // no signature to echo upstream; dropped like other local-only reasoning echoes
    if (item.type === "function_call") { pendingAssistantBlocks.push({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: parse(item.arguments) }); continue; }
    if (item.type === "function_call_output") {
      flushAssistant();
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") }] });
      continue;
    }
    if (item.role === "assistant") { const text = responsesItemText(item.content); if (text) pendingAssistantBlocks.push({ type: "text", text }); continue; }
    if (item.role) { flushAssistant(); messages.push({ role: item.role === "developer" ? "user" : item.role, content: toAnthropicContent(item.content) }); }
  }
  flushAssistant();

  // Anthropic requires max_tokens > thinking.budget_tokens (and budget_tokens
  // >= 1024), so the tiered default budgets are capped to leave visible-output
  // headroom; a request too small to think at all drops the block entirely.
  const maxTokens = input.max_output_tokens ?? 4096;
  let thinking: AnthropicThinking | undefined = anthropicThinking(input.reasoning?.effort);
  if (thinking?.type === "enabled") {
    const budget = Math.min(thinking.budget_tokens ?? 0, Math.floor(maxTokens * 0.8));
    thinking = budget >= 1024 ? { type: "enabled", budget_tokens: budget } : undefined;
  }
  const toolChoice = anthropicToolChoice(input.tool_choice);
  const tools = Array.isArray(input.tools)
    ? input.tools.filter((tool: any) => typeof tool?.name === "string").map((tool: any) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), input_schema: tool.parameters ?? { type: "object", properties: {} } }))
    : undefined;
  return {
    model,
    messages,
    // Anthropic requires max_tokens; a Responses caller that omits max_output_tokens still needs a concrete value sent upstream.
    max_tokens: maxTokens,
    ...(input.instructions ? { system: input.instructions } : {}),
    ...(input.stream ? { stream: true } : {}),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { top_p: input.top_p }),
    ...(thinking ? { thinking } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(tools?.length ? { tools } : {}),
  };
}

export function fromAnthropicResponse(response: any, model: string): Record<string, unknown> {
  const content = Array.isArray(response.content) ? response.content : [];
  const output: any[] = [];
  const thinkingText = content.filter((part: any) => part?.type === "thinking").map((part: any) => part.thinking ?? "").join("");
  if (thinkingText) output.push({ type: "reasoning", id: `rs_${crypto.randomUUID()}`, summary: [{ type: "summary_text", text: thinkingText }] });
  const text = content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
  if (text) output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
  for (const part of content) {
    if (part?.type !== "tool_use") continue;
    output.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}), status: "completed" });
  }
  const incomplete = response.stop_reason === "max_tokens";
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const cached = response.usage?.cache_read_input_tokens;
  return {
    id: response.id ?? `resp_${crypto.randomUUID()}`,
    object: "response",
    status: incomplete ? "incomplete" : "completed",
    model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cached !== undefined && cached !== null ? { input_tokens_details: { cached_tokens: Number(cached) } } : {}),
    },
    ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
  };
}

/**
 * Chat Completions <-> Anthropic Messages API: the local `/v1/chat/completions`
 * endpoint reaching an upstream whose protocol is "anthropic". DeepSeek's
 * `thinking`/`reasoning_effort` extensions are intentionally not mapped here
 * — a generic Chat Completions client has no reason to send agentx's own
 * reasoning-control fields.
 */

/** Convert Chat Completions tool-choice variants to Anthropic's object-shaped tool_choice. */
function chatToolChoiceToAnthropic(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "none" || value === "auto") return { type: value };
    if (value === "required") return { type: "any" };
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const choice = value as { type?: string; function?: { name?: string } };
  if (choice.type === "function" && typeof choice.function?.name === "string") return { type: "tool", name: choice.function.name };
  return undefined;
}

function chatToolsToAnthropic(tools: unknown): any[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools.map((tool: any) => {
    const source = tool?.function ?? tool;
    if (!source || typeof source.name !== "string") return undefined;
    return { name: source.name, ...(source.description === undefined ? {} : { description: source.description }), input_schema: source.parameters ?? { type: "object", properties: {} } };
  }).filter((tool) => tool !== undefined);
  return mapped.length ? mapped : undefined;
}

function chatContentToAnthropic(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content.map((part: any) => {
    if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type === "image_url" && typeof part.image_url?.url === "string") { const source = toAnthropicImageSource(part.image_url.url); return source ? { type: "image", source } : undefined; }
    return undefined;
  }).filter((part) => part !== undefined);
  if (!parts.length) return "";
  return parts.every((part: any) => part.type === "text") ? parts.map((part: any) => part.text).join("") : parts;
}

export function toAnthropicRequestFromChat(input: any, model: string): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const message of input.messages ?? []) {
    if (message.role === "system") { if (typeof message.content === "string") systemParts.push(message.content); continue; }
    if (message.role === "tool") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") }] });
      continue;
    }
    const blocks: any[] = [];
    const converted = chatContentToAnthropic(message.content);
    if (Array.isArray(converted)) blocks.push(...converted);
    else if (converted) blocks.push({ type: "text", text: converted });
    for (const call of message.tool_calls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.function?.name, input: parse(call.function?.arguments) });
    if (blocks.length) messages.push({ role: message.role, content: blocks });
  }
  const stopSequences = typeof input.stop === "string" ? [input.stop] : Array.isArray(input.stop) ? input.stop : undefined;
  const toolChoice = chatToolChoiceToAnthropic(input.tool_choice);
  const tools = chatToolsToAnthropic(input.tools);
  return {
    model,
    messages,
    max_tokens: input.max_tokens ?? 4096,
    ...(systemParts.length ? { system: systemParts.join("\n") } : {}),
    ...(input.stream ? { stream: true } : {}),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { top_p: input.top_p }),
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(tools ? { tools } : {}),
  };
}

export function fromAnthropicResponseToChat(response: any, model: string): Record<string, unknown> {
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
  const thinking = content.filter((part: any) => part?.type === "thinking").map((part: any) => part.thinking ?? "").join("");
  const toolCalls = content.filter((part: any) => part?.type === "tool_use").map((part: any) => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } }));
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const cached = response.usage?.cache_read_input_tokens;
  return {
    id: response.id ?? `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text || null, ...(thinking ? { reasoning_content: thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? "tool_calls" : response.stop_reason === "max_tokens" ? "length" : "stop",
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cached !== undefined && cached !== null ? { prompt_tokens_details: { cached_tokens: Number(cached) } } : {}),
    },
  };
}

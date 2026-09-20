/**
 * Responses API <-> Anthropic Messages API: a custom provider can speak
 * native Anthropic Messages API, and Codex (which only ever sees the local
 * Responses endpoint) still needs to reach it. Unlike responses.ts, here the
 * upstream is Anthropic-shaped.
 */
import type { AnthropicMessage, AnthropicRequest, AnthropicThinking } from "./shared.js";
import type { JsonRecord, JsonValue } from "../json.js";
import { asRecords, isRecord, parseJson, recNum, recObj, recObjs, recStr } from "../json.js";
import { anthropicThinking, anthropicToolChoice, collapseAnthropicContent, textOfBlocks, toAnthropicImageSource, toolResultBlocks } from "./shared.js";

/** Responses message content (string or input_text/input_image parts) to Anthropic message content. */
function toAnthropicContent(content: JsonValue): JsonValue {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: JsonRecord[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const text = recStr(raw, "text");
    if (raw.type === "input_text" || raw.type === "output_text") { if (text) parts.push({ type: "text", text }); continue; }
    const url = recStr(raw, "image_url");
    if (raw.type === "input_image" && url) { const source = toAnthropicImageSource(url); if (source) parts.push({ type: "image", source }); }
  }
  return collapseAnthropicContent(parts);
}

/** Plain text of a Responses message item's content, ignoring non-text parts. */
function responsesItemText(content: JsonValue): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord)
    .filter((part) => part.type === "output_text" || part.type === "input_text")
    .map((part) => recStr(part, "text") ?? "").join("");
}

export function toAnthropicRequest(input: JsonRecord, model: string): AnthropicRequest {
  const rawInput = input.input;
  const items: JsonRecord[] = typeof rawInput === "string" ? [{ role: "user", content: rawInput }] : asRecords(rawInput);
  const messages: AnthropicMessage[] = [];
  // Responses represents one assistant turn as separate top-level items
  // (a message item for text, a function_call item per tool call); Anthropic
  // wants them merged back into one assistant message's content blocks.
  let pendingAssistantBlocks: JsonRecord[] = [];
  const flushAssistant = () => { if (pendingAssistantBlocks.length) { messages.push({ role: "assistant", content: pendingAssistantBlocks }); pendingAssistantBlocks = []; } };
  for (const item of items) {
    if (item.type === "reasoning") continue; // no signature to echo upstream; dropped like other local-only reasoning echoes
    if (item.type === "function_call") { pendingAssistantBlocks.push({ type: "tool_use", id: recStr(item, "call_id") ?? recStr(item, "id"), name: recStr(item, "name"), input: parseJson(item.arguments) }); continue; }
    if (item.type === "function_call_output") {
      flushAssistant();
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: item.call_id, content: toolResultBlocks(item.output) }] });
      continue;
    }
    if (item.role === "assistant") { const text = responsesItemText(item.content); if (text) pendingAssistantBlocks.push({ type: "text", text }); continue; }
    if (typeof item.role === "string") { flushAssistant(); messages.push({ role: item.role === "developer" ? "user" : item.role, content: toAnthropicContent(item.content) }); }
  }
  flushAssistant();

  // Anthropic requires max_tokens > thinking.budget_tokens (and budget_tokens
  // >= 1024), so the tiered default budgets are capped to leave visible-output
  // headroom; a request too small to think at all drops the block entirely.
  const maxTokens = recNum(input, "max_output_tokens") ?? 4096;
  let thinking: AnthropicThinking | undefined = anthropicThinking(recStr(recObj(input, "reasoning"), "effort"));
  if (thinking?.type === "enabled") {
    const budget = Math.min(thinking.budget_tokens ?? 0, Math.floor(maxTokens * 0.8));
    thinking = budget >= 1024 ? { type: "enabled", budget_tokens: budget } : undefined;
  }
  const toolChoice = anthropicToolChoice(input.tool_choice);
  const instructions = recStr(input, "instructions");
  const temperature = recNum(input, "temperature");
  const top_p = recNum(input, "top_p");
  const tools = asRecords(input.tools).flatMap((tool) => {
    const name = recStr(tool, "name");
    if (!name) return [];
    const description = recStr(tool, "description");
    return [{ name, ...(description === undefined ? {} : { description }), input_schema: tool.parameters ?? { type: "object", properties: {} } }];
  });
  return {
    model,
    messages,
    // Anthropic requires max_tokens; a Responses caller that omits max_output_tokens still needs a concrete value sent upstream.
    max_tokens: maxTokens,
    ...(instructions ? { system: instructions } : {}),
    ...(input.stream ? { stream: true } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(top_p === undefined ? {} : { top_p }),
    ...(thinking ? { thinking } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(tools.length ? { tools } : {}),
  };
}

export function fromAnthropicResponse(response: JsonRecord, model: string): JsonRecord {
  const content = recObjs(response, "content");
  const output: JsonRecord[] = [];
  const thinkingText = textOfBlocks(content, "thinking");
  if (thinkingText) output.push({ type: "reasoning", id: `rs_${crypto.randomUUID()}`, summary: [{ type: "summary_text", text: thinkingText }] });
  const text = textOfBlocks(content, "text");
  if (text) output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
  for (const part of content) {
    if (part.type !== "tool_use") continue;
    output.push({ type: "function_call", call_id: recStr(part, "id"), name: recStr(part, "name"), arguments: JSON.stringify(part.input ?? {}), status: "completed" });
  }
  const incomplete = response.stop_reason === "max_tokens";
  const usage = recObj(response, "usage");
  const inputTokens = recNum(usage, "input_tokens") ?? 0;
  const outputTokens = recNum(usage, "output_tokens") ?? 0;
  const cached = recNum(usage, "cache_read_input_tokens");
  return {
    id: recStr(response, "id") ?? `resp_${crypto.randomUUID()}`,
    object: "response",
    status: incomplete ? "incomplete" : "completed",
    model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }),
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

function chatToolsToAnthropic(tools: unknown): AnthropicRequest["tools"] | undefined {
  const mapped = asRecords(tools).flatMap((tool) => {
    const source = recObj(tool, "function") ?? tool;
    const name = recStr(source, "name");
    if (!name) return [];
    const description = recStr(source, "description");
    return [{ name, ...(description === undefined ? {} : { description }), input_schema: source.parameters ?? { type: "object", properties: {} } }];
  });
  return mapped.length ? mapped : undefined;
}

/** Chat Completions content (string or text/image_url parts) to Anthropic content. */
function chatContentToAnthropic(content: JsonValue): JsonValue {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: JsonRecord[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    if (raw.type === "text") { const text = recStr(raw, "text"); if (text) parts.push({ type: "text", text }); continue; }
    if (raw.type === "image_url") { const source = toAnthropicImageSource(recStr(recObj(raw, "image_url"), "url")); if (source) parts.push({ type: "image", source }); }
  }
  return collapseAnthropicContent(parts);
}

export function toAnthropicRequestFromChat(input: JsonRecord, model: string): AnthropicRequest {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const message of recObjs(input, "messages")) {
    const role = recStr(message, "role");
    if (role === "system") { const content = recStr(message, "content"); if (content) systemParts.push(content); continue; }
    if (role === "tool") {
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: toolResultBlocks(message.content) }] });
      continue;
    }
    if (typeof role !== "string") continue;
    const blocks: JsonRecord[] = [];
    const converted = chatContentToAnthropic(message.content);
    if (Array.isArray(converted)) blocks.push(...asRecords(converted));
    else if (converted) blocks.push({ type: "text", text: converted });
    for (const call of recObjs(message, "tool_calls")) blocks.push({ type: "tool_use", id: recStr(call, "id"), name: recStr(recObj(call, "function"), "name"), input: parseJson(recStr(recObj(call, "function"), "arguments")) });
    if (blocks.length) messages.push({ role, content: blocks });
  }
  const rawStop = input.stop;
  const stopSequences = typeof rawStop === "string" ? [rawStop] : Array.isArray(rawStop) ? rawStop.filter((part): part is string => typeof part === "string") : undefined;
  const toolChoice = anthropicToolChoice(input.tool_choice);
  const tools = chatToolsToAnthropic(input.tools);
  const temperature = recNum(input, "temperature");
  const top_p = recNum(input, "top_p");
  return {
    model,
    messages,
    max_tokens: recNum(input, "max_tokens") ?? 4096,
    ...(systemParts.length ? { system: systemParts.join("\n") } : {}),
    ...(input.stream ? { stream: true } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(top_p === undefined ? {} : { top_p }),
    ...(stopSequences ? { stop_sequences: stopSequences } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(tools ? { tools } : {}),
  };
}

export function fromAnthropicResponseToChat(response: JsonRecord, model: string): JsonRecord {
  const content = recObjs(response, "content");
  const text = textOfBlocks(content, "text");
  const thinking = textOfBlocks(content, "thinking");
  const toolCalls = content.filter((part) => part.type === "tool_use").map((part) => ({ id: recStr(part, "id"), type: "function", function: { name: recStr(part, "name"), arguments: JSON.stringify(part.input ?? {}) } }));
  const usage = recObj(response, "usage");
  const inputTokens = recNum(usage, "input_tokens") ?? 0;
  const outputTokens = recNum(usage, "output_tokens") ?? 0;
  const cached = recNum(usage, "cache_read_input_tokens");
  return {
    id: recStr(response, "id") ?? `chatcmpl_${crypto.randomUUID()}`,
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
      ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
    },
  };
}

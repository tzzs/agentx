export interface AnthropicMessage { role: string; content: unknown; }
export interface AnthropicThinking { type?: string; budget_tokens?: number; [key: string]: unknown; }
export interface AnthropicRequest {
  model?: string; system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number; messages: AnthropicMessage[]; stream?: boolean;
  temperature?: number; top_p?: number; stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
  thinking?: AnthropicThinking;
  output_config?: { effort?: string; [key: string]: unknown };
  tool_choice?: unknown;
  metadata?: unknown;
  context_management?: unknown;
}

/** Build a data URI (or pass through remote URLs) from an Anthropic image source. */
export function imageDataUri(source: any): string | undefined {
  if (!source) return undefined;
  if (source.type === "url" && typeof source.url === "string") return source.url;
  if (source.type === "base64" && typeof source.data === "string") return `data:${source.media_type ?? "image/png"};base64,${source.data}`;
  return undefined;
}

/** Normalize Claude/DeepSeek effort names to the Chat Completions values. */
export function reasoningEffort(input: any): "low" | "high" | "max" | undefined {
  const value = input?.output_config?.effort ?? input?.reasoning?.effort;
  if (typeof value !== "string") return undefined;
  if (value === "low") return "low";
  if (value === "max") return "max";
  if (value === "medium" || value === "high" || value === "xhigh" || value === "ultracode") return "high";
  return undefined;
}

/** Convert Anthropic thinking controls to DeepSeek's OpenAI-shaped control. */
export function chatThinking(input: any): { type: "enabled" | "disabled" } | undefined {
  const type = input?.thinking?.type;
  if (type === "disabled") return { type: "disabled" };
  if (type === "enabled" || type === "adaptive") return { type: "enabled" };
  if (input?.reasoning?.effort === "none") return { type: "disabled" };
  if (input?.reasoning?.effort !== undefined) return { type: "enabled" };
  return undefined;
}

/** Convert Anthropic tool-choice variants to Chat Completions variants. */
export function chatToolChoice(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "none" || value === "auto") return value;
    if (value === "any" || value === "required") return "required";
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const choice = value as { type?: string; name?: string; function?: { name?: string } };
  if (choice.type === "none" || choice.type === "auto") return choice.type;
  if (choice.type === "any" || choice.type === "required") return "required";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  if (choice.type === "function" && typeof choice.function?.name === "string") return value;
  return undefined;
}

/** Convert Anthropic tool-choice variants to Responses API variants. */
export function responsesToolChoice(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "none" || value === "auto" || value === "required") return value;
    if (value === "any") return "required";
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const choice = value as { type?: string; name?: string; function?: { name?: string } };
  if (choice.type === "none" || choice.type === "auto" || choice.type === "required") return choice.type;
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && typeof choice.name === "string") return { type: "function", name: choice.name };
  if (choice.type === "function" && typeof choice.function?.name === "string") return { type: "function", name: choice.function.name };
  return undefined;
}

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
  const toolUses = output.filter((item: any) => item.type === "function_call").map((item: any) => ({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: parseArguments(item.arguments) }));
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

function parseArguments(value: unknown): unknown { try { return typeof value === "string" ? JSON.parse(value) : value ?? {}; } catch { return {}; } }

/**
 * Responses ↔ Anthropic, the direction this file did not previously need:
 * a custom provider can speak native Anthropic Messages API, and Codex
 * (which only ever sees the local Responses endpoint) still needs to reach
 * it. `toResponsesRequest`/`fromResponsesResponse` above assume the upstream
 * is Responses-shaped; these two assume the upstream is Anthropic-shaped.
 */

/** Convert Responses tool-choice variants to Anthropic's object-shaped tool_choice ({"type": "auto"|"any"|"none"|"tool", name?}). */
function anthropicToolChoice(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "none" || value === "auto") return { type: value };
    if (value === "required") return { type: "any" };
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const choice = value as { type?: string; name?: string };
  if (choice.type === "function" && typeof choice.name === "string") return { type: "tool", name: choice.name };
  return undefined;
}

/**
 * Map a Responses `reasoning.effort` string to Anthropic's extended-thinking
 * control. Anthropic requires a concrete `budget_tokens` when thinking is
 * enabled but a Responses effort string carries no token budget, so these are
 * reasonable tiered defaults rather than a value derived from the request —
 * the same kind of approximation `reasoningEffort()` above already makes
 * collapsing effort levels into Chat Completions' three-value scale.
 */
function anthropicThinking(effort: unknown): AnthropicThinking | undefined {
  if (typeof effort !== "string") return undefined;
  if (effort === "none") return { type: "disabled" };
  if (effort === "low") return { type: "enabled", budget_tokens: 4096 };
  if (effort === "max") return { type: "enabled", budget_tokens: 32000 };
  if (effort === "medium" || effort === "high" || effort === "xhigh" || effort === "ultracode") return { type: "enabled", budget_tokens: 16000 };
  return undefined;
}

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
    if (item.type === "function_call") { pendingAssistantBlocks.push({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: parseArguments(item.arguments) }); continue; }
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
  let thinking = anthropicThinking(input.reasoning?.effort);
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

/**
 * Helpers shared across every conversion direction (chat.ts / responses.ts /
 * anthropic.ts): the Anthropic request shape they all consume, image/effort/
 * thinking/tool-choice field mapping, and small parsing utilities.
 */

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

/** Convert Responses tool-choice variants to Anthropic's object-shaped tool_choice ({"type": "auto"|"any"|"none"|"tool", name?}). */
export function anthropicToolChoice(value: unknown): unknown {
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
export function anthropicThinking(effort: unknown): AnthropicThinking | undefined {
  if (typeof effort !== "string") return undefined;
  if (effort === "none") return { type: "disabled" };
  if (effort === "low") return { type: "enabled", budget_tokens: 4096 };
  if (effort === "max") return { type: "enabled", budget_tokens: 32000 };
  if (effort === "medium" || effort === "high" || effort === "xhigh" || effort === "ultracode") return { type: "enabled", budget_tokens: 16000 };
  return undefined;
}

/** Sampling knobs shared by both upstream protocols (undefined drops the key). */
export function samplingParams(input: Record<string, any>): Record<string, unknown> {
  return {
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { top_p: input.top_p }),
    ...(input.stop_sequences === undefined ? {} : { stop: input.stop_sequences }),
  };
}

export function chatControlParams(input: any, deepSeek: boolean): Record<string, unknown> {
  const thinking = deepSeek ? chatThinking(input) : undefined;
  const effort = deepSeek ? reasoningEffort(input) : undefined;
  const toolChoice = chatToolChoice(input.tool_choice);
  return {
    ...(thinking ? { thinking } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
}

/** Best-effort JSON parse; malformed or absent input becomes `{}` rather than throwing. */
export function parse(value: unknown): unknown {
  try { return typeof value === "string" ? JSON.parse(value) : value ?? {}; } catch { return {}; }
}

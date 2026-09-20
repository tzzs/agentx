/**
 * Helpers shared across every conversion direction (chat.ts / responses.ts /
 * anthropic.ts): the Anthropic request shape they all consume and the
 * image/effort/thinking/tool-choice field mapping between dialects. The
 * dynamic-JSON accessors they read payloads with live in ../json.ts.
 */
import type { JsonRecord, JsonValue } from "../json.js";
import { asRecords, isRecord, recObj, recStr } from "../json.js";

/**
 * The Anthropic Messages request shape the converters consume: a message
 * list plus the few fields whose structure they rely on. `AnthropicMessage`
 * is a plain record because a client's messages carry whatever blocks they
 * carry; each is read through the accessors from ../json.ts.
 */
export type AnthropicMessage = JsonRecord;
export interface AnthropicThinking extends JsonRecord { type?: string; budget_tokens?: number; }
export interface AnthropicRequest extends JsonRecord {
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number; messages: AnthropicMessage[]; stream?: boolean;
  temperature?: number; top_p?: number; stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema: JsonValue }>;
}

/**
 * Interpret a payload from the Anthropic-shaped `/v1/messages` endpoint as an
 * `AnthropicRequest`. The endpoint's contract *is* that shape, so this is the
 * one place it is asserted rather than re-checked; `messages` is still
 * filtered to its object entries so converters can iterate it safely, and a
 * body that violates the rest fails at the upstream.
 */
export function asAnthropicRequest(value: JsonRecord): AnthropicRequest {
  return { ...value, messages: asRecords(value.messages) } as AnthropicRequest;
}

/**
 * One top-level entry of a Responses request's `input` (message, function_call,
 * reasoning, function_call_output…). Raw client JSON, so fields are read
 * through the accessors above rather than declared here.
 */
export type ResponsesItem = JsonRecord;

/** Build an Anthropic image content block from a Responses `input_image.image_url`, which may be a real URL or a data: URI. */
export function toAnthropicImageSource(url: string | undefined): { type: "url"; url: string } | { type: "base64"; media_type: string; data: string } | undefined {
  if (!url) return undefined;
  const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (dataMatch) {
    const [, media_type = "", data = ""] = dataMatch;
    return { type: "base64", media_type, data };
  }
  return { type: "url", url };
}

/** Shared collapse rule for content arrays: pure-text arrays flatten to a joined string; mixed arrays stay blocks; empty becomes "". */
export function collapseAnthropicContent(parts: JsonRecord[]): JsonValue {
  if (!parts.length) return "";
  return parts.every((part) => part.type === "text") ? parts.map((part) => recStr(part, "text") ?? "").join("") : parts;
}

/** Plain text of an Anthropic content array for the given block type, ignoring everything else. */
export function textOfBlocks(content: JsonRecord[], type: "text" | "thinking"): string {
  const key = type === "text" ? "text" : "thinking";
  return content.filter((part) => part.type === type).map((part) => recStr(part, key) ?? "").join("");
}

/** Build a data URI (or pass through remote URLs) from an Anthropic image source. */
export function imageDataUri(source: JsonRecord | undefined): string | undefined {
  if (!source) return undefined;
  if (source.type === "url") return recStr(source, "url");
  if (source.type === "base64") {
    const data = recStr(source, "data");
    return data ? `data:${recStr(source, "media_type") ?? "image/png"};base64,${data}` : undefined;
  }
  return undefined;
}

/** Normalize Claude/DeepSeek/Codex effort names to the Chat Completions values. */
export function reasoningEffort(input: JsonRecord | undefined): "low" | "high" | "max" | undefined {
  const value = recStr(recObj(input, "output_config"), "effort") ?? recStr(recObj(input, "reasoning"), "effort");
  if (value === "minimal" || value === "low") return "low";
  if (value === "medium" || value === "high" || value === "xhigh" || value === "ultracode") return "high";
  if (value === "max" || value === "ultra") return "max";
  return undefined;
}

/** Convert Anthropic thinking controls to DeepSeek's OpenAI-shaped control. */
export function chatThinking(input: JsonRecord | undefined): { type: "enabled" | "disabled" } | undefined {
  const type = recStr(recObj(input, "thinking"), "type");
  if (type === "disabled") return { type: "disabled" };
  if (type === "enabled" || type === "adaptive") return { type: "enabled" };
  const effort = recStr(recObj(input, "reasoning"), "effort");
  if (effort === "none") return { type: "disabled" };
  if (effort !== undefined) return { type: "enabled" };
  return undefined;
}

/** Convert Anthropic tool-choice variants to Chat Completions variants. */
export function chatToolChoice(value: JsonValue): JsonValue | undefined {
  if (typeof value === "string") {
    if (value === "none" || value === "auto") return value;
    if (value === "any" || value === "required") return "required";
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const type = recStr(value, "type");
  if (type === "none" || type === "auto") return type;
  if (type === "any" || type === "required") return "required";
  const name = forcedToolName(value);
  return name ? { type: "function", function: { name } } : undefined;
}

/** Convert Anthropic tool-choice variants to Responses API variants. */
export function responsesToolChoice(value: JsonValue): JsonValue | undefined {
  if (typeof value === "string") {
    if (value === "none" || value === "auto" || value === "required") return value;
    if (value === "any") return "required";
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const type = recStr(value, "type");
  if (type === "none" || type === "auto" || type === "required") return type;
  if (type === "any") return "required";
  const name = forcedToolName(value);
  return name ? { type: "function", name } : undefined;
}

/** Name of the tool a `{"type": "tool"|"function"}` choice forces, in either the Anthropic (top-level `name`) or Chat Completions (`function.name`) dialect. */
function forcedToolName(choice: JsonRecord): string | undefined {
  const type = recStr(choice, "type");
  if (type !== "tool" && type !== "function") return undefined;
  return recStr(choice, "name") ?? recStr(recObj(choice, "function"), "name");
}

/**
 * Convert a Responses or Chat Completions tool-choice variant to Anthropic's
 * object-shaped tool_choice ({"type": "auto"|"any"|"none"|"tool", name?}). The
 * two dialects name the forced tool differently — Responses uses a top-level
 * `name`, Chat Completions nests it under `function` — and both are accepted.
 */
export function anthropicToolChoice(value: unknown): JsonRecord | undefined {
  if (typeof value === "string") {
    if (value === "none" || value === "auto") return { type: value };
    if (value === "required") return { type: "any" };
    return undefined;
  }
  if (!isRecord(value) || value.type !== "function") return undefined;
  const name = recStr(value, "name") ?? recStr(recObj(value, "function"), "name");
  return name ? { type: "tool", name } : undefined;
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
  if (effort === "minimal") return { type: "enabled", budget_tokens: 1024 };
  if (effort === "low") return { type: "enabled", budget_tokens: 4096 };
  if (effort === "max" || effort === "ultra") return { type: "enabled", budget_tokens: 32000 };
  if (effort === "medium" || effort === "high" || effort === "xhigh" || effort === "ultracode") return { type: "enabled", budget_tokens: 16000 };
  return undefined;
}

/** Sampling knobs shared by both upstream protocols (undefined drops the key). */
export function samplingParams(input: JsonRecord): JsonRecord {
  return {
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { top_p: input.top_p }),
    ...(input.stop_sequences === undefined ? {} : { stop: input.stop_sequences }),
  };
}

export function chatControlParams(input: JsonRecord, deepSeek: boolean): JsonRecord {
  const thinking = deepSeek ? chatThinking(input) : undefined;
  const effort = deepSeek ? reasoningEffort(input) : undefined;
  const toolChoice = chatToolChoice(input.tool_choice);
  return {
    ...(thinking ? { thinking } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
}

/**
 * Leading text of the synthetic user message that carries media lifted out of
 * a tool result. Chat Completions' `role:"tool"` message accepts only a
 * string, so an image returned by a tool has no legal place there and must
 * travel as its own user turn.
 */
export const TOOL_RESULT_MEDIA_PROMPT = "Attached media from tool result:";

export interface ToolResultContent {
  /** Plain text of the result; always a string, safe for tool messages that must be string-only. */
  text: string;
  /** Image data URIs (or remote URLs) lifted out of the result's content blocks. */
  images: string[];
}

/**
 * Split an Anthropic `tool_result` content value into plain text and images.
 *
 * The block array used to be forwarded as `JSON.stringify(content)`, which
 * turned a tool-returned screenshot into its own base64 payload rendered as
 * literal text: the model could not see the image, and a 1MB PNG entered the
 * context as ~1.37M characters. Splitting the two lets each caller place the
 * image wherever its upstream protocol actually accepts one.
 */
export function toolResultContent(content: unknown): ToolResultContent {
  if (typeof content === "string") return { text: content, images: [] };
  if (content === undefined || content === null) return { text: "", images: [] };
  if (!Array.isArray(content)) return { text: JSON.stringify(content), images: [] };
  const text: string[] = [];
  const images: string[] = [];
  for (const part of content as JsonValue[]) {
    if (isRecord(part) && part.type === "text") {
      const value = recStr(part, "text");
      if (value !== undefined) text.push(value);
      continue;
    }
    if (isRecord(part) && part.type === "image") {
      const url = imageDataUri(recObj(part, "source"));
      if (url) images.push(url);
      continue;
    }
    // Anthropic documents only text and image blocks here; anything else is
    // kept as text rather than dropped, so an unknown block still reaches the model.
    if (part !== undefined && part !== null) text.push(typeof part === "string" ? part : JSON.stringify(part));
  }
  return { text: text.join("\n"), images };
}

/**
 * Text for a tool message, given how many images its result carried and
 * whether they are being forwarded.
 *
 * Two things need saying. A media-only result must not end up with empty
 * text, which several chat upstreams reject. And an image that is *not*
 * forwarded has to be announced whatever else the result said — otherwise a
 * text-only model is silently missing content it was never told about.
 */
export function toolResultText(text: string, imageCount: number, forwarded: boolean): string {
  if (!imageCount) return text;
  const plural = imageCount === 1 ? "" : "s";
  // A forwarded image speaks for itself wherever it ended up, so it only needs
  // a stand-in when it would otherwise leave the tool message empty.
  if (forwarded) return text || `[${imageCount} image${plural} returned by the tool]`;
  const note = `[${imageCount} image${plural} returned by the tool; omitted because this model does not accept image input]`;
  return text ? `${text}\n${note}` : note;
}

/**
 * Whether images may be forwarded to this model. Metadata is only populated
 * once models.dev/OpenRouter have been fetched (the Codex catalog path), so
 * an unset `modalities` means "unknown", not "text only" — and an unknown
 * model is treated as capable, matching how images in ordinary user messages
 * have always been forwarded without a capability check.
 */
export function acceptsImageInput(provider?: { modalities?: string[] }): boolean {
  return provider?.modalities === undefined || provider.modalities.includes("image");
}

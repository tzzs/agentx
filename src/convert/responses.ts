/** Anthropic Messages API <-> Responses API: the direction whose upstream speaks the Responses protocol. */
import type { AnthropicMessage, AnthropicRequest, ResponsesItem } from "./shared.js";
import type { JsonRecord, JsonValue } from "../json.js";
import { asRecords, isRecord, parse, recNum, recObj, recObjs, recStr } from "../json.js";
import { acceptsImageInput, chatThinking, imageDataUri, reasoningEffort, responsesToolChoice, toolResultContent, toolResultText } from "./shared.js";
import type { ProviderModel } from "../providers/types.js";
import { fromAnthropicResponseToChat, toAnthropicRequestFromChat } from "./anthropic.js";

function convertContent(content: JsonValue[], assistant: boolean): JsonValue[] {
  return content.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const part = raw;
    if (part.type === "text") return [{ type: assistant ? "output_text" : "input_text", text: recStr(part, "text") ?? "" }];
    if (part.type === "image") { const url = imageDataUri(recObj(part, "source")); return url ? [{ type: "input_image", image_url: url }] : []; }
    // tool_use / tool_result never reach here: toResponsesInput maps those
    // blocks itself and only sends single non-tool parts through this map.
    return [part];
  });
}

/**
 * Build a Responses `function_call_output` from an Anthropic tool_result.
 * Unlike a Chat Completions tool message, `output` accepts either a plain
 * string or an array of typed parts, so an image a tool returned survives as
 * a real `input_image` instead of being flattened into a JSON string that
 * carried its base64 upstream as literal text.
 */
function toFunctionCallOutput(part: JsonRecord, allowImages: boolean): ResponsesItem {
  const { text, images } = toolResultContent(part.content);
  const media = allowImages ? images : [];
  if (!media.length) return { type: "function_call_output", call_id: part.tool_use_id, output: toolResultText(text, images.length, false) };
  return {
    type: "function_call_output",
    call_id: part.tool_use_id,
    output: [
      ...(text ? [{ type: "input_text", text }] : []),
      ...media.map((image_url) => ({ type: "input_image", image_url })),
    ],
  };
}

export function toResponsesRequest(input: AnthropicRequest, model: string, provider?: ProviderModel): JsonRecord {
  const thinking = chatThinking(input);
  const effort = reasoningEffort(input);
  const toolChoice = responsesToolChoice(input.tool_choice);
  const body: JsonRecord = {
    model, input: toResponsesInput(input.messages, acceptsImageInput(provider)),
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
function isThinkingPart(part: JsonRecord): boolean { return part.type === "thinking" || part.type === "redacted_thinking"; }

function toResponsesInput(messages: AnthropicMessage[], allowImages = true): ResponsesItem[] {
  const output: ResponsesItem[] = [];
  for (const message of messages) {
    const assistant = message.role === "assistant";
    if (!Array.isArray(message.content)) { output.push({ ...message }); continue; }
    const textParts: ResponsesItem[] = [];
    for (const raw of message.content) {
      if (!isRecord(raw)) continue;
      const part = raw;
      if (isThinkingPart(part)) continue;
      if (part.type === "tool_use") { output.push({ type: "function_call", call_id: recStr(part, "id"), name: recStr(part, "name"), arguments: JSON.stringify(part.input ?? {}) }); continue; }
      if (part.type === "tool_result") { output.push(toFunctionCallOutput(part, allowImages)); continue; }
      const converted = convertContent([part], assistant)[0];
      if (isRecord(converted)) textParts.push(converted);
    }
    if (textParts.length) output.push({ role: message.role, content: textParts });
  }
  return output;
}

function reasoningText(output: ResponsesItem[]): string {
  return output
    .filter((item) => item.type === "reasoning")
    .flatMap((item) => [
      ...recObjs(item, "summary").map((part) => recStr(part, "text") ?? ""),
      ...recObjs(item, "content").filter((part) => part.type === "reasoning_text").map((part) => recStr(part, "text") ?? ""),
    ])
    .join("");
}

export function fromResponsesResponse(response: JsonRecord, model: string): JsonRecord {
  const output = asRecords(response.output);
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => asRecords(item.content))
    .filter((part) => part.type === "output_text")
    .map((part) => recStr(part, "text") ?? "").join("");
  const toolUses = output.filter((item) => item.type === "function_call").map((item) => ({ type: "tool_use", id: recStr(item, "call_id") ?? recStr(item, "id"), name: recStr(item, "name"), input: parse(recStr(item, "arguments")) }));
  const thinking = reasoningText(output);
  const usage = recObj(response, "usage");
  const cached = recNum(recObj(usage, "input_tokens_details"), "cached_tokens");
  return {
    id: recStr(response, "id") ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model,
    content: [...(thinking ? [{ type: "thinking", thinking }] : []), ...(text ? [{ type: "text", text }] : []), ...toolUses],
    stop_reason: toolUses.length ? "tool_use" : response.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: recNum(usage, "input_tokens") ?? 0,
      output_tokens: recNum(usage, "output_tokens") ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached ?? 0
    }
  };
}

/** Return a failure for a Responses result that must not look like a turn end. */
export function responsesResponseFailure(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  if (response.status === "failed") {
    const error = response.error;
    return (isRecord(error) ? recStr(error, "message") : undefined) ?? (typeof error === "string" ? error : undefined) ?? "The upstream response failed.";
  }
  if (response.status === "incomplete") {
    const reason = recStr(recObj(response, "incomplete_details"), "reason");
    if (reason !== "max_output_tokens") return `The upstream response is incomplete (${String(reason ?? "unknown")}).`;
  }
  return undefined;
}

/**
 * Chat Completions <-> Responses API: the local `/v1/chat/completions`
 * endpoint reaching an upstream whose protocol is "responses". Reuses
 * `toAnthropicRequestFromChat`/`toResponsesRequest` instead of writing a
 * separate chat->Responses request mapping.
 */
export function toResponsesRequestFromChat(input: JsonRecord, model: string): JsonRecord {
  return toResponsesRequest(toAnthropicRequestFromChat(input, model), model);
}

/** Reuses `fromResponsesResponse`/`fromAnthropicResponseToChat` instead of writing a separate Responses->chat response mapping. */
export function fromResponsesResponseToChat(response: JsonRecord, model: string): JsonRecord {
  return fromAnthropicResponseToChat(fromResponsesResponse(response, model), model);
}

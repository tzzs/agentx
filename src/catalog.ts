import type { AnthropicMessage, AnthropicRequest } from "./providers.js";
import { imageDataUri } from "./providers.js";
import { allModels, providerFor as resolveProvider } from "./providers/registry.js";
import type { ProviderModel } from "./providers/types.js";

export type ModelProvider = ProviderModel;
export const providers = allModels;
export function providerFor(model: string, provider?: string): ModelProvider { return resolveProvider(model, provider); }
/**
 * Resolve the effective model. A fixed configuration wins; "auto" routes by
 * request shape but only within the models of the target provider so a pinned
 * provider never receives a model id it does not serve.
 */
export function selectModel(request: AnthropicRequest, configured: string, providerId?: string): string {
  if (configured !== "auto") return configured;
  // Responses-protocol bodies carry `input` instead of `messages`; either way
  // the JSON length is only a rough request-size signal.
  const size = JSON.stringify(request.messages ?? (request as any).input ?? "").length;
  const ranked = ["gpt-5.6-luna", "deepseek-v4-pro", "deepseek-v4-flash"];
  const wanted = request.tools?.length || size > 10000 ? ranked[0] : size > 2000 ? ranked[1] : ranked[2];
  if (!providerId) return wanted;
  const candidates = allModels.filter((item) => item.provider === providerId).map((item) => item.model);
  return candidates.includes(wanted) ? wanted : candidates[0] ?? wanted;
}

/** Sampling knobs shared by both upstream protocols (undefined drops the key). */
function samplingParams(input: Record<string, any>): Record<string, unknown> {
  return {
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { top_p: input.top_p }),
    ...(input.stop_sequences === undefined ? {} : { stop: input.stop_sequences }),
  };
}

export function toChatRequest(input: AnthropicRequest, model: string) {
  const messages: any[] = [];
  if (input.system) messages.push({ role: "system", content: typeof input.system === "string" ? input.system : input.system.map((part) => part.text ?? "").join("\n") });
  for (const message of input.messages) messages.push(...toChatMessages(message));
  return { model, messages, ...(input.max_tokens === undefined ? {} : { max_tokens: input.max_tokens }), ...(input.stream ? { stream: true } : {}), ...samplingParams(input as any), ...(input.tools ? { tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}) };
}

function toChatImagePart(part: any): any | undefined {
  const url = imageDataUri(part?.source);
  return url ? { type: "image_url", image_url: { url } } : undefined;
}

function toChatMessages(message: AnthropicMessage): any[] {
  if (!Array.isArray(message.content)) return [{ role: message.role, content: message.content ?? "" }];
  const parts: any[] = [];
  const toolCalls: any[] = [];
  const toolResults: any[] = [];
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
    } else if (part.type === "image") {
      const image = toChatImagePart(part);
      if (image) parts.push(image);
    }
  }
  const output: any[] = [];
  if (parts.length) output.push({ role: message.role, content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("") : parts });
  if (toolCalls.length) output.push({ role: "assistant", content: null, tool_calls: toolCalls });
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
  const message = response.choices?.[0]?.message ?? {}; const content = [];
  if (message.reasoning_content) content.push({ type: "thinking", thinking: message.reasoning_content });
  const text = chatText(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function?.name, input: parse(call.function?.arguments) });
  return { id: response.id ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: message.tool_calls?.length ? "tool_use" : response.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0 } };
}

export function toChatCompletionsRequest(input: any, model: string) {
  const messages: any[] = [];
  if (input.instructions) messages.push({ role: "system", content: input.instructions });
  const items = typeof input.input === "string" ? [{ role: "user", content: input.input }] : input.input ?? [];
  for (const item of items) {
    if (item.type === "function_call") {
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id ?? item.id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } }] });
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
    } else if (item.role) {
      messages.push({ role: item.role === "developer" ? "system" : item.role, content: responseContent(item.content) });
    }
  }
  return { model, messages, ...(input.max_output_tokens === undefined ? {} : { max_tokens: input.max_output_tokens }), ...(input.stream ? { stream: true } : {}), ...samplingParams(input), ...(input.tools ? { tools: input.tools.map((tool: any) => ({ type: "function", function: { name: tool.name ?? tool.function?.name, description: tool.description ?? tool.function?.description, parameters: tool.parameters ?? tool.function?.parameters } })) } : {}) };
}

export function fromChatResponseToResponses(response: any, model: string): Record<string, unknown> {
  const message = response.choices?.[0]?.message ?? {}; const output: any[] = [];
  if (message.reasoning_content) output.push({ type: "reasoning", id: `rs_${crypto.randomUUID()}`, summary: [{ type: "summary_text", text: message.reasoning_content }] });
  const text = chatText(message.content);
  if (text) output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
  for (const call of message.tool_calls ?? []) output.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? "{}", status: "completed" });
  const cached = response.usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = response.usage?.completion_tokens_details?.reasoning_tokens;
  return { id: response.id ?? `resp_${crypto.randomUUID()}`, object: "response", status: "completed", model, output, usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0, total_tokens: response.usage?.total_tokens ?? 0, ...(cached !== undefined && cached !== null ? { input_tokens_details: { cached_tokens: Number(cached) } } : {}), ...(reasoning !== undefined && reasoning !== null ? { output_tokens_details: { reasoning_tokens: Number(reasoning) } } : {}) } };
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
function parse(value: unknown) { try { return typeof value === "string" ? JSON.parse(value) : value ?? {}; } catch { return {}; } }

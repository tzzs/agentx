import type { AnthropicRequest } from "./providers.js";

export interface ModelProvider { model: string; protocol: "responses" | "chat-completions"; endpoint: string; }
const base = "https://opencode.ai/zen/go/v1";
export const providers: ModelProvider[] = [
  { model: "gpt-5.6-luna", protocol: "responses", endpoint: `${base}/responses` },
  { model: "deepseek-v4-pro", protocol: "chat-completions", endpoint: `${base}/chat/completions` },
  { model: "deepseek-v4-flash", protocol: "chat-completions", endpoint: `${base}/chat/completions` }
];
export function providerFor(model: string): ModelProvider { const provider = providers.find((item) => item.model === model); if (!provider) throw new Error(`Model "${model}" is not available. Available models: ${providers.map((item) => item.model).join(", ")}`); return provider; }
export function toChatRequest(input: AnthropicRequest, model: string) {
  const messages = [...(input.system ? [{ role: "system", content: typeof input.system === "string" ? input.system : input.system.map((part) => part.text ?? "").join("\n") }] : []), ...input.messages];
  return { model, messages, ...(input.max_tokens === undefined ? {} : { max_tokens: input.max_tokens }), ...(input.stream ? { stream: true } : {}), ...(input.tools ? { tools: input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}) };
}
export function fromChatResponse(response: any, model: string): Record<string, unknown> {
  const message = response.choices?.[0]?.message ?? {}; const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function?.name, input: parse(call.function?.arguments) });
  return { id: response.id ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: message.tool_calls?.length ? "tool_use" : response.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0 } };
}
function parse(value: unknown) { try { return typeof value === "string" ? JSON.parse(value) : value ?? {}; } catch { return {}; } }

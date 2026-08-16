import type { AnthropicRequest } from "./providers.js";

export interface ModelProvider { model: string; protocol: "responses" | "chat-completions"; endpoint: string; }
const base = "https://opencode.ai/zen/go/v1";
export const providers: ModelProvider[] = [
  { model: "gpt-5.6-luna", protocol: "responses", endpoint: `${base}/responses` },
  { model: "deepseek-v4-pro", protocol: "chat-completions", endpoint: `${base}/chat/completions` },
  { model: "deepseek-v4-flash", protocol: "chat-completions", endpoint: `${base}/chat/completions` },
  ...["minimax-m3", "minimax-m2.7", "minimax-m2.5", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "glm-5.2", "glm-5.3", "glm-5.1", "glm-5", "mimo-v2.5-pro", "mimo-v2.5", "hy3"].map((model) => ({ model, protocol: "chat-completions" as const, endpoint: `${base}/chat/completions` }))
];
export function providerFor(model: string): ModelProvider { const provider = providers.find((item) => item.model === model); if (!provider) throw new Error(`Model "${model}" is not available. Available models: ${providers.map((item) => item.model).join(", ")}`); return provider; }
export function selectModel(request: AnthropicRequest, configured: string): string {
  if (configured !== "auto") return configured;
  const size = JSON.stringify(request.messages).length;
  return request.tools?.length || size > 10000 ? "gpt-5.6-luna" : size > 2000 ? "deepseek-v4-pro" : "deepseek-v4-flash";
}
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
  return { model, messages, ...(input.max_output_tokens === undefined ? {} : { max_tokens: input.max_output_tokens }), ...(input.stream ? { stream: true } : {}), ...(input.tools ? { tools: input.tools.map((tool: any) => ({ type: "function", function: { name: tool.name ?? tool.function?.name, description: tool.description ?? tool.function?.description, parameters: tool.parameters ?? tool.function?.parameters } })) } : {}) };
}

export function fromChatResponseToResponses(response: any, model: string): Record<string, unknown> {
  const message = response.choices?.[0]?.message ?? {}; const output: any[] = [];
  if (message.content) output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: message.content }] });
  for (const call of message.tool_calls ?? []) output.push({ type: "function_call", call_id: call.id, name: call.function?.name, arguments: call.function?.arguments ?? "{}", status: "completed" });
  return { id: response.id ?? `resp_${crypto.randomUUID()}`, object: "response", status: "completed", model, output, usage: { input_tokens: response.usage?.prompt_tokens ?? 0, output_tokens: response.usage?.completion_tokens ?? 0, total_tokens: response.usage?.total_tokens ?? 0 } };
}

function responseContent(content: any): any {
  if (!Array.isArray(content)) return content ?? "";
  return content.map((part) => part.type === "input_text" || part.type === "output_text" ? part.text ?? "" : part).join("");
}
function parse(value: unknown) { try { return typeof value === "string" ? JSON.parse(value) : value ?? {}; } catch { return {}; } }

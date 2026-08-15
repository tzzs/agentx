export const RESPONSES_ENDPOINT = "https://opencode.ai/zen/go/v1/responses";

export interface AnthropicMessage { role: string; content: unknown; }
export interface AnthropicRequest {
  model?: string; system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number; messages: AnthropicMessage[]; stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
}

function convertContent(content: any): any {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "tool_result") return { type: "function_call_output", call_id: part.tool_use_id, output: typeof part.content === "string" ? part.content : JSON.stringify(part.content) };
    if (part.type === "tool_use") return { type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.input ?? {}) };
    return part;
  });
}

export function toResponsesRequest(input: AnthropicRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model, input: input.messages.map((message) => ({ ...message, content: convertContent(message.content) })),
    ...(input.max_tokens === undefined ? {} : { max_output_tokens: input.max_tokens }),
    ...(input.stream ? { stream: true } : {})
  };
  if (input.tools) body.tools = input.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema }));
  if (input.system !== undefined) {
    body.instructions = typeof input.system === "string"
      ? input.system
      : input.system.map((part) => part.text ?? "").join("\n");
  }
  return body;
}

export function fromResponsesResponse(response: any, model: string): Record<string, unknown> {
  const output = response.output ?? [];
  const text = output
    .filter((item: any) => item.type === "message")
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part.type === "output_text")
    .map((part: any) => part.text ?? "").join("");
  const toolUses = output.filter((item: any) => item.type === "function_call").map((item: any) => ({ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: parseArguments(item.arguments) }));
  return {
    id: response.id ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model,
    content: [...(text ? [{ type: "text", text }] : []), ...toolUses], stop_reason: toolUses.length ? "tool_use" : response.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 }
  };
}

function parseArguments(value: unknown): unknown { try { return typeof value === "string" ? JSON.parse(value) : value ?? {}; } catch { return {}; } }

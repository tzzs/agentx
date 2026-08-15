export const RESPONSES_ENDPOINT = "https://opencode.ai/zen/go/v1/responses";

export interface AnthropicMessage { role: string; content: unknown; }
export interface AnthropicRequest {
  model?: string; system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number; messages: AnthropicMessage[]; stream?: boolean;
}

export function toResponsesRequest(input: AnthropicRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model, input: input.messages,
    ...(input.max_tokens === undefined ? {} : { max_output_tokens: input.max_tokens }),
    ...(input.stream ? { stream: true } : {})
  };
  if (input.system !== undefined) {
    body.instructions = typeof input.system === "string"
      ? input.system
      : input.system.map((part) => part.text ?? "").join("\n");
  }
  return body;
}

export function fromResponsesResponse(response: any, model: string): Record<string, unknown> {
  const text = (response.output ?? [])
    .filter((item: any) => item.type === "message")
    .flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part.type === "output_text")
    .map((part: any) => part.text ?? "").join("");
  return {
    id: response.id ?? `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model,
    content: [{ type: "text", text }], stop_reason: response.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 }
  };
}

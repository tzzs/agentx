import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { fromResponsesResponse, toResponsesRequest, type AnthropicRequest } from "./providers.js";
import { pipeResponsesStream } from "./streaming.js";
import { fromChatResponse, providerFor, selectModel, toChatRequest } from "./catalog.js";

export interface Adapter { server: ReturnType<typeof createServer>; token: string; port: number; close(): Promise<void>; }

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(value); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => { let data = ""; request.setEncoding("utf8"); request.on("data", (chunk) => data += chunk); request.on("end", () => resolve(data)); request.on("error", reject); });
}
function json(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }

export async function startAdapter(config: Config): Promise<Adapter> {
  if (!config.apiKey) throw new Error("OpenCode Go API key not found. Set OPENCODE_GO_API_KEY or use --api-key <key>.");
  // Claude Code validates the key shape before sending a request. This is still
  // a local-only random token and is never forwarded to the upstream provider.
  const token = `sk-ant-api03-${randomBytes(32).toString("hex")}`;
  const server = createServer(async (request, response) => {
    if (request.url === "/health" && request.method === "GET") return json(response, 200, { status: "ok" });
    if (request.url === "/v1/models" && request.method === "GET") return json(response, 200, { data: [{ id: config.model, object: "model" }] });
    if (request.url === "/v1/responses" && request.method === "POST") {
      if (!authorized(request, token)) return json(response, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
      try {
        const input = JSON.parse(await body(request));
        const model = input.model ?? config.model;
        const provider = providerFor(model);
        if (provider.protocol !== "responses") return json(response, 400, { error: { message: `Model "${model}" is not available through the Codex Responses API.`, type: "invalid_request_error" } });
        const upstream = await fetch(provider.endpoint, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ ...input, model }) });
        const contentType = upstream.headers.get("content-type") ?? "application/json";
        response.writeHead(upstream.status, { "content-type": contentType });
        if (upstream.body) { for await (const chunk of upstream.body as any) response.write(chunk); }
        return response.end();
      } catch (error) { return json(response, 400, { error: { message: error instanceof Error ? error.message : "Invalid request", type: "invalid_request_error" } }); }
    }
    if (request.url !== "/v1/messages" || request.method !== "POST") return json(response, 404, { error: { message: "Not found", type: "not_found" } });
    if (!authorized(request, token)) return json(response, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
    try {
      const input = JSON.parse(await body(request)) as AnthropicRequest;
      const model = selectModel(input, config.model); const provider = providerFor(model);
      if (input.stream) {
        const upstream = await fetch(provider.endpoint, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(provider.protocol === "responses" ? toResponsesRequest(input, model) : toChatRequest(input, model)) });
        if (!upstream.ok) return json(response, upstream.status, { error: { message: `OpenCode Go returned HTTP ${upstream.status}`, type: "upstream_error" } });
        return pipeResponsesStream(upstream, response, model);
      }
      const upstream = await fetch(provider.endpoint, {
        method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(provider.protocol === "responses" ? toResponsesRequest(input, model) : toChatRequest(input, model))
      });
      if (!upstream.ok) return json(response, upstream.status, { error: { message: `OpenCode Go returned HTTP ${upstream.status}`, type: "upstream_error" } });
      const value = await upstream.json(); return json(response, 200, provider.protocol === "responses" ? fromResponsesResponse(value, model) : fromChatResponse(value, model));
    } catch (error) { return json(response, 400, { error: { message: error instanceof Error ? error.message : "Invalid request", type: "invalid_request_error" } }); }
  });
  let port = config.port;
  await new Promise<void>((resolve, reject) => {
    const listen = () => { const onError = (error: NodeJS.ErrnoException) => { server.removeListener("listening", onListening); if (error.code === "EADDRINUSE") { port++; listen(); } else reject(error); }; const onListening = () => { server.removeListener("error", onError); resolve(); }; server.once("error", onError); server.once("listening", onListening); server.listen(port, config.host); };
    listen();
  });
  return { server, token, port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

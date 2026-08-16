import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { fromResponsesResponse, toResponsesRequest, type AnthropicRequest } from "./providers.js";
import { pipeChatStreamToResponses, pipeResponsesStream } from "./streaming.js";
import { fromChatResponse, fromChatResponseToResponses, providerFor, selectModel, toChatCompletionsRequest, toChatRequest } from "./catalog.js";

export interface Adapter { server: ReturnType<typeof createServer>; token: string; port: number; close(): Promise<void>; }

function authorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const apiKey = request.headers["x-api-key"];
  const value = authorization ?? (Array.isArray(apiKey) ? apiKey[0] : apiKey) ?? "";
  const a = Buffer.from(value); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => { let data = ""; request.setEncoding("utf8"); request.on("data", (chunk) => data += chunk); request.on("end", () => resolve(data)); request.on("error", reject); });
}
function json(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
function debug(config: Config, message: string) { if (config.logLevel === "debug") console.error(`[adapter] ${message}`); }
async function upstreamError(response: ServerResponse, upstream: Response, status: number) {
  let message = `OpenCode Go returned HTTP ${status}`;
  try { const value = await upstream.json(); message = value?.error?.message ?? message; } catch { /* Keep the status fallback. */ }
  return json(response, status, { error: { message, type: "upstream_error" } });
}

export async function startAdapter(config: Config): Promise<Adapter> {
  if (!config.apiKey) throw new Error("OpenCode Go API key not found. Set OPENCODE_GO_API_KEY or use --api-key <key>.");
  // Claude Code validates the key shape before sending a request. This is still
  // a local-only random token and is never forwarded to the upstream provider.
  const token = `sk-ant-api03-${randomBytes(32).toString("hex")}`;
  const server = createServer(async (request, response) => {
    debug(config, `${request.method} ${request.url}`);
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health" && request.method === "GET") return json(response, 200, { status: "ok" });
    if (pathname === "/api/hello" && (request.method === "HEAD" || request.method === "GET")) { response.writeHead(200); return response.end(); }
    if (pathname === "/v1/models" && request.method === "GET") return json(response, 200, {
      data: [
        { id: config.model, object: "model" },
        { id: "sonnet", object: "model" },
        { id: "claude-sonnet-5", object: "model" }
      ]
    });
    if (pathname === "/v1/responses" && request.method === "POST") {
      if (!authorized(request, token)) return json(response, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
      try {
        const input = JSON.parse(await body(request));
        const model = input.model ?? config.model;
        const provider = providerFor(model);
        debug(config, `POST /v1/responses model=${model}`);
        const upstream = await fetch(provider.endpoint, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(provider.protocol === "responses" ? { ...input, model } : toChatCompletionsRequest(input, model)) });
        debug(config, `provider status=${upstream.status}`);
        if (input.stream && provider.protocol === "chat-completions") return pipeChatStreamToResponses(upstream, response, model);
        const contentType = upstream.headers.get("content-type") ?? "application/json";
        response.writeHead(upstream.status, { "content-type": contentType });
        if (provider.protocol === "responses" && upstream.body) { for await (const chunk of upstream.body as any) response.write(chunk); return response.end(); }
        if (upstream.body) return response.end(JSON.stringify(fromChatResponseToResponses(await upstream.json(), model)));
        return response.end();
      } catch (error) { debug(config, `responses error=${error instanceof Error ? error.message : "unknown"}`); return json(response, 400, { error: { message: error instanceof Error ? error.message : "Invalid request", type: "invalid_request_error" } }); }
    }
    if (pathname !== "/v1/messages" || request.method !== "POST") return json(response, 404, { error: { message: "Not found", type: "not_found" } });
    if (!authorized(request, token)) return json(response, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
    try {
      const input = JSON.parse(await body(request)) as AnthropicRequest;
      const model = selectModel(input, config.model); const provider = providerFor(model);
      debug(config, `POST /v1/messages model=${model} stream=${Boolean(input.stream)}`);
      if (input.stream) {
        const upstream = await fetch(provider.endpoint, { method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(provider.protocol === "responses" ? toResponsesRequest(input, model) : toChatRequest(input, model)) });
        debug(config, `provider status=${upstream.status}`);
        if (!upstream.ok) return upstreamError(response, upstream, upstream.status);
        return pipeResponsesStream(upstream, response, input.model ?? "sonnet");
      }
      const upstream = await fetch(provider.endpoint, {
        method: "POST", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(provider.protocol === "responses" ? toResponsesRequest(input, model) : toChatRequest(input, model))
      });
      debug(config, `provider status=${upstream.status}`);
      if (!upstream.ok) return upstreamError(response, upstream, upstream.status);
      const value = await upstream.json(); return json(response, 200, provider.protocol === "responses" ? fromResponsesResponse(value, input.model ?? "sonnet") : fromChatResponse(value, input.model ?? "sonnet"));
    } catch (error) { debug(config, `messages error=${error instanceof Error ? error.message : "unknown"}`); return json(response, 400, { error: { message: error instanceof Error ? error.message : "Invalid request", type: "invalid_request_error" } }); }
  });
  let port = config.port;
  await new Promise<void>((resolve, reject) => {
    const listen = () => { const onError = (error: NodeJS.ErrnoException) => { server.removeListener("listening", onListening); if (error.code === "EADDRINUSE") { port++; listen(); } else reject(error); }; const onListening = () => { server.removeListener("error", onError); resolve(); }; server.once("error", onError); server.once("listening", onListening); server.listen(port, config.host); };
    listen();
  });
  return { server, token, port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

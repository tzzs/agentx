import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { fromResponsesResponse, toResponsesRequest, type AnthropicRequest } from "./providers.js";
import { pipeChatStreamToResponses, pipeResponsesPassthrough, pipeResponsesStream, type StreamUsageOptions } from "./streaming.js";
import type { ProviderModel } from "./providers/types.js";
import type { TokenUsage } from "./usage/types.js";
import { fromChatResponse, fromChatResponseToResponses, providerFor, providers, selectModel, toChatCompletionsRequest, toChatRequest } from "./catalog.js";
import { apiKeyFor, providerDisplayName } from "./providers/registry.js";
import { defaultModelFor } from "./selection.js";
import { extractUsage } from "./providers/usage/index.js";
import { TokenUsageCollector } from "./usage/collector.js";
import { defaultUsageStore } from "./usage/storage.js";
import type { UsagePeriod, UsageStore } from "./usage/types.js";

export interface Adapter { server: ReturnType<typeof createServer>; token: string; port: number; sessionId: string; store: UsageStore; close(): Promise<void>; }

export interface AdapterOptions { store?: UsageStore; }

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
function parsePeriod(url: URL): UsagePeriod | undefined {
  const value = url.searchParams.get("period");
  return value === "today" || value === "week" || value === "month" || value === "all" ? value : undefined;
}
function streamOptions(provider: ProviderModel, sessionId: string, onUsage?: (usage: TokenUsage) => void): StreamUsageOptions {
  return { provider: provider.provider, model: provider.model, protocol: provider.protocol, sessionId, onUsage };
}
/** ~4 characters per token is a good-enough basis when the upstream stays silent. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
async function upstreamError(response: ServerResponse, providerName: string, upstream: Response, status: number) {
  let message = `${providerName} returned HTTP ${status}`;
  try { const value = await upstream.json(); message = value?.error?.message ?? message; } catch { /* Keep the status fallback. */ }
  return json(response, status, { error: { message, type: "upstream_error" } });
}
/** Abort when the upstream sends nothing (headers or body) for this long. */
const UPSTREAM_IDLE_MS = 180_000;

/**
 * Progress watchdog for one proxied request. Cancels as soon as the local
 * client leaves, or when the upstream stops making progress. This owns the
 * idle policy instead of undici's fixed five-minute headers/body timeouts,
 * which killed legitimately slow turns with an opaque abort error.
 */
function upstreamSession(response: ServerResponse, config: Config, idleMs = UPSTREAM_IDLE_MS) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      debug(config, `upstream idle for ${Math.round(idleMs / 1000)}s; aborting`);
      controller.abort(new Error(`upstream made no progress for ${Math.round(idleMs / 1000)}s`));
    }, idleMs);
    timer.unref();
  };
  arm();
  response.on("close", () => { clearTimeout(timer); controller.abort(); });
  return {
    signal: controller.signal,
    /** Reset the idle window; call whenever bytes arrive from upstream. */
    progress: () => arm(),
  };
}

/** Pipe the upstream body through a tap that feeds the idle watchdog. */
function watchedBody(stream: ReadableStream<Uint8Array> | null, progress: () => void): ReadableStream<Uint8Array> | null {
  if (!stream) return null;
  return stream.pipeThrough(new TransformStream({ transform(chunk, controller) { progress(); controller.enqueue(chunk); } }));
}

export async function startAdapter(config: Config, options: AdapterOptions = {}): Promise<Adapter> {
  // "auto" defers model resolution to per-request routing; validate against
  // the provider's default model instead so startup still verifies the key.
  const initialModel = config.model === "auto" ? defaultModelFor(config.provider ?? "opencode") : config.model;
  const initialProvider = providerFor(initialModel, config.provider); const initialApiKey = apiKeyFor(initialProvider, config.apiKey);
  if (!initialApiKey) throw new Error(`API key not found for provider "${initialProvider.provider}". Set the provider API key environment variable or use --api-key <key>.`);
  // Claude Code validates the key shape before sending a request. This is still
  // a local-only random token and is never forwarded to the upstream provider.
  const token = `sk-ant-api03-${randomBytes(32).toString("hex")}`;
  const store = options.store ?? await defaultUsageStore();
  const collector = new TokenUsageCollector(store);
  const sessionId = randomUUID();
  const sessionFor = (input: any) => typeof input?.session_id === "string" ? input.session_id : sessionId;
  const recordUsage = (value: any, provider: ProviderModel, session: string) => { const usage = extractUsage(value, provider, { sessionId: session }); if (usage) safeRecord(usage); };
  const safeRecord = (usage: TokenUsage) => { collector.record(usage).catch((error) => debug(config, `usage record error=${error instanceof Error ? error.message : "unknown"}`)); };
  /** POST the converted payload upstream; network failures surface as HTTP 502. */
  const forward = async (provider: ProviderModel, apiKey: string, payload: unknown, signal: AbortSignal): Promise<Response> => {
    try {
      return await fetch(provider.endpoint, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(payload), signal });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      debug(config, `upstream unreachable=${reason}`);
      throw Object.assign(new Error(`${providerDisplayName(provider.provider)} is unreachable (${reason})`), { status: 502 });
    }
  };
  const server = createServer(async (request, response) => {
    debug(config, `${request.method} ${request.url}`);
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/health" && request.method === "GET") return json(response, 200, { status: "ok" });
    if (pathname === "/usage/session" && request.method === "GET") {
      const id = url.searchParams.get("id") ?? sessionId;
      return json(response, 200, await store.sessionTotals(id));
    }
    if (pathname.startsWith("/usage/session/") && request.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/usage/session/".length));
      return json(response, 200, await store.sessionTotals(id));
    }
    if (pathname === "/usage/providers" && request.method === "GET") {
      const period = parsePeriod(url);
      return json(response, 200, await store.providerStats(period));
    }
    if (pathname === "/usage/stats" && request.method === "GET") {
      const period = parsePeriod(url);
      return json(response, 200, await store.totals(period));
    }
    if (pathname === "/v1/models" && request.method === "GET") return json(response, 200, {
      data: providers.filter((item) => !config.provider || item.provider === config.provider).map((item) => ({ id: item.model, object: "model", owned_by: item.provider }))
    });
    if (pathname === "/v1/responses" && request.method === "POST") {
      if (!authorized(request, token)) return json(response, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
      try {
        const input = JSON.parse(await body(request));
        // Honor auto routing here too: Codex echoes OPENAI_MODEL=auto back.
        const model = selectModel(input as AnthropicRequest, input.model ?? config.model, config.provider);
        const provider = providerFor(model, config.provider); const apiKey = apiKeyFor(provider, config.apiKey);
        debug(config, `POST /v1/responses model=${model}`);
        const payload = provider.protocol === "responses" ? { ...input, model } : toChatCompletionsRequest(input, model);
        const inputEstimate = estimateTokens(JSON.stringify(payload));
        const session = upstreamSession(response, config);
        const upstream = await forward(provider, apiKey, payload, session.signal);
        session.progress();
        debug(config, `provider status=${upstream.status}`);
        if (!upstream.ok) return upstreamError(response, providerDisplayName(provider.provider), upstream, upstream.status);
        const watched = new Response(watchedBody(upstream.body, session.progress), { status: upstream.status });
        if (input.stream && provider.protocol === "chat-completions") return pipeChatStreamToResponses(watched, response, model, { ...streamOptions(provider, sessionFor(input), safeRecord), inputEstimate });
        if (input.stream) return pipeResponsesPassthrough(watched, response, model, { ...streamOptions(provider, sessionFor(input), safeRecord), inputEstimate });
        if (watched.body && provider.protocol === "chat-completions") { const value = await watched.json(); recordUsage(value, provider, sessionFor(input)); return json(response, upstream.status, fromChatResponseToResponses(value, model)); }
        if (watched.body) { const value = await watched.json(); recordUsage(value, provider, sessionFor(input)); return json(response, upstream.status, value); }
        return response.end();
      } catch (error) {
        debug(config, `responses error=${error instanceof Error ? error.message : "unknown"}`);
        const status = (error as { status?: number })?.status ?? 400;
        const type = status >= 500 ? "upstream_error" : "invalid_request_error";
        return json(response, status, { error: { message: error instanceof Error ? error.message : "Invalid request", type } });
      }
    }
    if (pathname !== "/v1/messages" || request.method !== "POST") return json(response, 404, { error: { message: "Not found", type: "not_found" } });
    if (!authorized(request, token)) return json(response, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
    try {
      const input = JSON.parse(await body(request)) as AnthropicRequest;
      const model = selectModel(input, config.model, config.provider); const provider = providerFor(model, config.provider); const apiKey = apiKeyFor(provider, config.apiKey);
      debug(config, `POST /v1/messages model=${model} stream=${Boolean(input.stream)}`);
      const payload = provider.protocol === "responses" ? toResponsesRequest(input, model) : toChatRequest(input, model);
      const inputEstimate = estimateTokens(JSON.stringify(payload));
      const session = upstreamSession(response, config);
      const upstream = await forward(provider, apiKey, payload, session.signal);
      session.progress();
      debug(config, `provider status=${upstream.status}`);
      if (!upstream.ok) return upstreamError(response, providerDisplayName(provider.provider), upstream, upstream.status);
      const watched = new Response(watchedBody(upstream.body, session.progress), { status: upstream.status });
      if (input.stream) return pipeResponsesStream(watched, response, model, { ...streamOptions(provider, sessionFor(input), safeRecord), inputEstimate });
      const value = await watched.json(); recordUsage(value, provider, sessionFor(input)); return json(response, 200, provider.protocol === "responses" ? fromResponsesResponse(value, model) : fromChatResponse(value, model));
    } catch (error) {
      debug(config, `messages error=${error instanceof Error ? error.message : "unknown"}`);
      const status = (error as { status?: number })?.status ?? 400;
      const type = status >= 500 ? "upstream_error" : "invalid_request_error";
      return json(response, status, { error: { message: error instanceof Error ? error.message : "Invalid request", type } });
    }
  });
  let port = config.port;
  const lastPort = Math.min(config.port + 100, 65535);
  await new Promise<void>((resolve, reject) => {
    const listen = () => { const onError = (error: NodeJS.ErrnoException) => { server.removeListener("listening", onListening); if (error.code === "EADDRINUSE" && port < lastPort) { port++; listen(); } else reject(error); }; const onListening = () => { const address = server.address(); if (address && typeof address === "object") port = address.port; server.removeListener("error", onError); resolve(); }; server.once("error", onError); server.once("listening", onListening); server.listen(port, config.host); };
    listen();
  });
  return { server, token, port, sessionId, store, close: async () => { await collector.close(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

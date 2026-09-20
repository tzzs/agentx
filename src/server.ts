import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { asAnthropicRequest, chatResponseFailure, fromAnthropicResponse, fromAnthropicResponseToChat, fromChatResponse, fromChatResponseToResponses, fromResponsesResponse, fromResponsesResponseToChat, responsesResponseFailure, toAnthropicRequest, toAnthropicRequestFromChat, toChatCompletionsRequest, toChatRequest, toResponsesRequest, toResponsesRequestFromChat } from "./convert/index.js";
import type { JsonRecord } from "./json.js";
import { jsonRecord, recStr } from "./json.js";
import { pipeAnthropicPassthrough, pipeAnthropicStreamToChat, pipeAnthropicStreamToResponses, pipeChatPassthrough, pipeChatStreamToResponses, pipeResponsesPassthrough, pipeResponsesStream, pipeResponsesStreamToChat, type StreamUsageOptions } from "./streaming/index.js";
import type { ProviderModel, ProviderProtocol } from "./providers/types.js";
import type { TokenUsage } from "./usage/types.js";
import { honorRequestedModel, providerFor, providers } from "./catalog.js";
import { apiKeyFor, isPlaceholderModel, providerDisplayName } from "./providers/registry.js";
import { extractUsage } from "./providers/usage/index.js";
import { TokenUsageCollector } from "./usage/collector.js";
import { defaultUsageStore } from "./usage/storage.js";
import type { UsageStore } from "./usage/types.js";

export interface Adapter { server: ReturnType<typeof createServer>; token: string; port: number; sessionId: string; close(): Promise<void>; }

export interface AdapterOptions { store?: UsageStore; /** Request-body ceiling; overridable so the limit is testable without shipping 64MB through a socket. */
  maxBodyBytes?: number; /** Grace period before close() force-closes lingering connections; overridable so the fallback path is testable without a multi-second wait. */
  closeGraceMs?: number; }

function authorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const apiKey = request.headers["x-api-key"];
  const value = authorization ?? (Array.isArray(apiKey) ? apiKey[0] : apiKey) ?? "";
  const a = Buffer.from(value); const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Reject request bodies above this size: a runaway client must not buffer unbounded memory in the adapter. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
function body(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""; let size = 0; let rejected = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        // Reject without destroying the request: request and response share
        // one socket, so destroying it here would drop the connection before
        // the 413 response below could ever reach the client.
        rejected = true;
        reject(Object.assign(new Error("Request body exceeds 64MB limit"), { status: 413 }));
        return;
      }
      data += chunk;
    });
    request.on("end", () => { if (!rejected) resolve(data); });
    request.on("error", reject);
  });
}
function json(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); }
function debug(config: Config, message: string) { if (config.logLevel === "debug") console.error(`[adapter] ${message}`); }
function streamOptions(config: Config, provider: ProviderModel, sessionId: string, onUsage?: (usage: TokenUsage) => void): StreamUsageOptions {
  return { provider: provider.provider, model: provider.model, protocol: provider.protocol, sessionId, onUsage, onDiagnostic: (message) => debug(config, `stream diagnostic: ${message}`) };
}
async function upstreamError(response: ServerResponse, providerName: string, upstream: Response, status: number) {
  let message = `${providerName} returned HTTP ${status}`;
  try { const value = await upstream.json(); message = value?.error?.message ?? message; } catch { /* Keep the status fallback. */ }
  return json(response, status, { error: { message, type: "upstream_error" } });
}
/** Map a thrown error to a JSON error response (400 client / 5xx upstream). */
function respondError(response: ServerResponse, error: unknown) {
  const status = (error as { status?: number })?.status ?? 400;
  const type = status >= 500 ? "upstream_error" : "invalid_request_error";
  json(response, status, { error: { message: error instanceof Error ? error.message : "Invalid request", type } });
}
/** Anthropic's Messages API authenticates via x-api-key + anthropic-version, not Authorization: Bearer. Both forms are sent for an "anthropic" upstream so a gateway that only accepts Bearer still works. */
function authHeaders(provider: ProviderModel, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  if (provider.protocol === "anthropic") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
  return headers;
}
/** POST the converted payload upstream; network failures surface as HTTP 502. */
async function forward(config: Config, provider: ProviderModel, apiKey: string, payload: unknown, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(provider.endpoint, { method: "POST", headers: authHeaders(provider, apiKey), body: JSON.stringify(payload), signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    debug(config, `upstream unreachable=${reason}`);
    throw Object.assign(new Error(`${providerDisplayName(provider.provider)} is unreachable (${reason})`), { status: 502 });
  }
}

/** Base delay, growth factor, and ceiling for the retry backoff below. */
const RETRY_BASE_MS = 300;
const RETRY_MAX_DELAY_MS = 4_000;
/** Upstream statuses worth a retry: rate-limited or transiently unavailable. Other 4xx are client/config errors that retrying cannot fix. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Sleep that resolves early (no error) when `signal` aborts, so backoff never outlives a disconnected client or the idle watchdog. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exponential backoff with jitter, capped at RETRY_MAX_DELAY_MS; a numeric-seconds `Retry-After` raises the floor but never the cap. */
function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  const backoff = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  const jittered = backoff * (0.8 + Math.random() * 0.4);
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
  return Math.min(RETRY_MAX_DELAY_MS, Math.max(jittered, retryAfterMs));
}

/**
 * Wrap `forward()` with bounded retry for transient upstream failures: a
 * network-level failure (surfaced by `forward()` as a status:502 Error) or a
 * 429/502/503/504 response. Other statuses — including other 4xx — return
 * immediately; retrying a client/config error wastes time without changing
 * the outcome. This must be the only place that calls `forward()`: retries
 * only ever happen before any response body reaches the client (this
 * function resolves or throws before the caller starts streaming), so a
 * retry can never corrupt bytes already forwarded downstream.
 */
export async function forwardWithRetry(
  config: Config, provider: ProviderModel, apiKey: string, payload: unknown, signal: AbortSignal, retry: number,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
): Promise<Response> {
  const attempts = retry + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await forward(config, provider, apiKey, payload, signal);
      if (response.ok || attempt === attempts || !RETRYABLE_STATUS.has(response.status)) return response;
      const delay = retryDelayMs(attempt, response.headers.get("retry-after"));
      debug(config, `retry attempt=${attempt}/${attempts} status=${response.status} delay=${Math.round(delay)}ms`);
      await sleep(delay, signal);
    } catch (error) {
      if (attempt === attempts || signal.aborted) throw error;
      const delay = retryDelayMs(attempt, null);
      debug(config, `retry attempt=${attempt}/${attempts} status=network-error delay=${Math.round(delay)}ms`);
      await sleep(delay, signal);
    }
  }
  /* istanbul ignore next -- the loop always returns or throws by the final attempt. */
  throw new Error("forwardWithRetry: unreachable");
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

/**
 * Shared proxy pipeline for one request: authenticate, parse the body,
 * resolve provider/model/key, convert the payload to the upstream protocol,
 * forward it with the idle watchdog, and map failures to errors. Returns
 * `undefined` after answering the request directly (auth failure, non-OK
 * upstream status); otherwise yields the parsed request and the watched
 * upstream response.
 */
async function proxyRequest(
  config: Config,
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  fallbackModel: string,
  payload: (input: JsonRecord, model: string, provider: ProviderModel) => unknown,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<{ input: JsonRecord; model: string; provider: ProviderModel; watched: Response } | undefined> {
  if (!authorized(request, token)) { json(response, 401, { error: { message: "Invalid API key", type: "authentication_error" } }); return undefined; }
  try {
    const input = jsonRecord(JSON.parse(await body(request, maxBodyBytes)));
    // The endpoint decides which model id counts as "configured"; clients
    // that echo a preferred model (e.g. Codex sending OPENAI_MODEL=auto back)
    // are honored per honorRequestedModel's rules.
    const model = honorRequestedModel(recStr(input, "model"), fallbackModel, config.provider);
    debug(config, `POST ${request.url} model=${model}`);
    const provider = providerFor(model, config.provider); const apiKey = apiKeyFor(provider, config.apiKey);
    const payloadBody = payload(input, model, provider);
    const session = upstreamSession(response, config);
    const upstream = await forwardWithRetry(config, provider, apiKey, payloadBody, session.signal, config.retry);
    session.progress();
    debug(config, `provider status=${upstream.status}`);
    if (!upstream.ok) { await upstreamError(response, providerDisplayName(provider.provider), upstream, upstream.status); return undefined; }
    const watched = new Response(watchedBody(upstream.body, session.progress), { status: upstream.status });
    return { input, model, provider, watched };
  } catch (error) {
    debug(config, `proxy error=${error instanceof Error ? error.message : "unknown"}`);
    respondError(response, error);
    return undefined;
  }
}

/**
 * Per client-facing endpoint: how to build the upstream payload for each
 * provider protocol, which pipe serves each streaming combination, and how
 * to translate a non-streaming upstream JSON back to this endpoint's format.
 * Invariant: the pipe/translator selected always matches the protocol whose
 * payload builder ran (e.g. a 200 with no body on an Anthropic upstream goes
 * to the Anthropic pipe, never the Responses one).
 */
interface EndpointSpec {
  payloads: Record<ProviderProtocol, (input: JsonRecord, model: string, provider: ProviderModel) => unknown>;
  pipes: Record<ProviderProtocol, (upstream: Response, response: ServerResponse, model: string, options: StreamUsageOptions) => Promise<void>>;
  /** Non-stream JSON translation; an upstream-reported failure maps to a 502 instead. */
  finish(upstream: JsonRecord, provider: ProviderModel, model: string): unknown;
  /** In-band failure message carried by a non-OK-shaped 200 payload, if any. */
  failure?(upstream: JsonRecord, provider: ProviderModel): string | undefined;
}

const ENDPOINT_SPECS: Record<"responses" | "chat" | "messages", EndpointSpec> = {
  responses: {
    payloads: {
      "responses": (input, model) => ({ ...input, model }),
      "chat-completions": (input, model, provider) => toChatCompletionsRequest(input, model, provider.provider),
      "anthropic": (input, model) => toAnthropicRequest(input, model),
    },
    pipes: {
      "chat-completions": pipeChatStreamToResponses,
      "responses": pipeResponsesPassthrough,
      "anthropic": pipeAnthropicStreamToResponses,
    },
    finish: (upstream, provider, model) => provider.protocol === "anthropic"
      ? fromAnthropicResponse(upstream, model)
      : provider.protocol === "chat-completions" ? fromChatResponseToResponses(upstream, model) : upstream,
    failure: (upstream, provider) => provider.protocol === "chat-completions" ? chatResponseFailure(upstream) : provider.protocol === "responses" ? responsesResponseFailure(upstream) : undefined,
  },
  chat: {
    payloads: {
      "responses": (input, model) => toResponsesRequestFromChat(input, model),
      "chat-completions": (input, model) => ({ ...input, model }),
      "anthropic": (input, model) => toAnthropicRequestFromChat(input, model),
    },
    pipes: {
      "chat-completions": pipeChatPassthrough,
      "responses": pipeResponsesStreamToChat,
      "anthropic": pipeAnthropicStreamToChat,
    },
    finish: (upstream, provider, model) => provider.protocol === "anthropic"
      ? fromAnthropicResponseToChat(upstream, model)
      : provider.protocol === "responses" ? fromResponsesResponseToChat(upstream, model) : upstream,
    failure: (upstream, provider) => provider.protocol === "responses" ? responsesResponseFailure(upstream) : provider.protocol === "chat-completions" ? chatResponseFailure(upstream) : undefined,
  },
  messages: {
    payloads: {
      "responses": (input, model) => toResponsesRequest(asAnthropicRequest(input), model),
      "chat-completions": (input, model, provider) => toChatRequest(asAnthropicRequest(input), model, provider.provider),
      // already Anthropic-shaped; zero conversion
      "anthropic": (input, model) => ({ ...input, model }),
    },
    pipes: {
      "chat-completions": pipeResponsesStream,
      "responses": pipeResponsesStream,
      "anthropic": pipeAnthropicPassthrough,
    },
    // Anthropic upstreams are already Anthropic-shaped; others convert back.
    finish: (upstream, provider) => provider.protocol === "anthropic" ? upstream : provider.protocol === "responses" ? fromResponsesResponse(upstream, provider.model) : fromChatResponse(upstream, provider.model),
    failure: (upstream, provider) => provider.protocol === "chat-completions" ? chatResponseFailure(upstream) : provider.protocol === "responses" ? responsesResponseFailure(upstream) : undefined,
  },
};

export async function startAdapter(config: Config, options: AdapterOptions = {}): Promise<Adapter> {
  const initialModel = config.model;
  const initialProvider = providerFor(initialModel, config.provider); const initialApiKey = apiKeyFor(initialProvider, config.apiKey);
  if (!initialApiKey) throw new Error(`API key not found for provider "${initialProvider.provider}". Set the provider API key environment variable or use --api-key <key>.`);
  // Claude Code validates the key shape before sending a request. This is still
  // a local-only random token and is never forwarded to the upstream provider.
  const token = `sk-ant-api03-${randomBytes(32).toString("hex")}`;
  const store = options.store ?? await defaultUsageStore();
  const collector = new TokenUsageCollector(store);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const closeGraceMs = options.closeGraceMs ?? 3_000;
  const sessionId = randomUUID();
  const sessionFor = (input: JsonRecord) => recStr(input, "session_id") ?? sessionId;
  /** Record one usage row, swallowing persistence errors into debug logs. */
  const safeRecord = (usage: TokenUsage) => { void collector.record(usage).catch((error) => debug(config, `usage record error=${error instanceof Error ? error.message : "unknown"}`)); };
  const recordUsage = (value: JsonRecord, provider: ProviderModel, session: string) => { const usage = extractUsage(value, provider, { sessionId: session }); if (usage) safeRecord(usage); };
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    debug(config, `${request.method} ${request.url}`);
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/health" && request.method === "GET") return json(response, 200, { status: "ok" });
    // Usage statistics are read through `agentx usage` (direct storage access);
    // the former unauthenticated /usage/* HTTP endpoints were removed.
    if (pathname === "/v1/models" && request.method === "GET") return json(response, 200, {
      data: providers.filter((item) => (!config.provider || item.provider === config.provider) && !isPlaceholderModel(item)).map((item) => ({ id: item.model, object: "model", owned_by: item.provider }))
    });
    const specFor = pathname === "/v1/responses" ? ENDPOINT_SPECS.responses
      : pathname === "/v1/chat/completions" ? ENDPOINT_SPECS.chat
        : pathname === "/v1/messages" ? ENDPOINT_SPECS.messages
          : undefined;
    if (!specFor || request.method !== "POST") return json(response, 404, { error: { message: "Not found", type: "not_found" } });
    const proxied = await proxyRequest(config, request, response, token, config.model, (input, model, provider) => specFor.payloads[provider.protocol](input, model, provider), maxBodyBytes);
    if (!proxied) return;
    const { input, model, provider, watched } = proxied;
    const usageOptions = streamOptions(config, provider, sessionFor(input), safeRecord);
    if (input.stream) return specFor.pipes[provider.protocol](watched, response, model, usageOptions);
    if (!watched.body) { response.end(); return; }
    const value = await watched.json(); recordUsage(value, provider, sessionFor(input));
    const failure = specFor.failure?.(value, provider);
    if (failure) return json(response, 502, { error: { message: failure, type: "upstream_error" } });
    return json(response, watched.status, specFor.finish(value, provider, model));
  };
  const server = createServer((request, response) => {
    // Last-resort guard: a rejection escaping the per-route handling (an
    // upstream 200 with a truncated JSON body, a failing usage store, …) must
    // never surface as an unhandledRejection — Node would terminate the whole
    // adapter mid-session.
    handleRequest(request, response).catch((error) => {
      debug(config, `handler error=${error instanceof Error ? error.message : "unknown"}`);
      if (!response.headersSent) json(response, 500, { error: { message: "Internal adapter error", type: "api_error" } });
      else response.end();
    });
  });
  let port = config.port;
  const lastPort = Math.min(config.port + 100, 65535);
  await new Promise<void>((resolve, reject) => {
    const listen = () => { const onError = (error: NodeJS.ErrnoException) => { server.removeListener("listening", onListening); if (error.code === "EADDRINUSE" && port < lastPort) { port++; listen(); } else reject(error); }; const onListening = () => { const address = server.address(); if (address && typeof address === "object") port = address.port; server.removeListener("error", onError); resolve(); }; server.once("error", onError); server.once("listening", onListening); server.listen(port, config.host); };
    listen();
  });
  return { server, token, port, sessionId, close: async () => {
    await collector.close();
    await new Promise<void>((resolve) => {
      // Keep-alive or in-flight SSE connections would otherwise hold the
      // callback-based close() open indefinitely; force them shut after a
      // short grace period so CLI exit is never blocked by a lingering socket.
      const force = setTimeout(() => server.closeAllConnections(), closeGraceMs);
      force.unref();
      server.close(() => { clearTimeout(force); resolve(); });
    });
  } };
}

# Plan: Token Usage Statistics for Every Provider

Status: Proposed
Date: 2026-08-22

## Goal

Add a complete token usage statistics system that collects, normalizes, persists,
and displays token consumption for every LLM provider. The implementation must
keep provider-specific statistics logic out of the core system so that adding a
new provider requires only:

1. A provider usage adapter (extracts tokens from the raw API response).
2. A pricing configuration.
3. No changes to the core runtime, storage, or UI layers.

## Architecture Rules

- Core layer understands `TokenUsage` only — never raw API responses.
- Provider layer understands API responses and maps them into `TokenUsage`.
- Storage layer understands statistics / aggregates.
- UI layer (CLI) understands visualization.
- Do NOT add token logic inside the Agent runtime or per-provider conditions
  scattered through the codebase.

## Layered Design

```
Raw API Response
      |
      v
ProviderUsageAdapter (per provider / protocol)
      |  extractUsage(response) -> TokenUsage
      v
TokenUsageCollector (normalize + persist)
      |
      v
UsageStore (SQLite)
      |
      v
Query API + CLI statistics
```

## Deliverables

1. **Unified `TokenUsage` model** — `src/usage/types.ts`
   Provider and model always present; missing numeric fields default to `0`.

2. **Provider usage adapters** — `src/providers/usage/`
   - `openai.ts` — Responses API (`input_tokens`/`output_tokens`) and
     Chat Completions (`prompt_tokens`/`completion_tokens`).
   - `anthropic.ts` — Messages API (`input_tokens`/`output_tokens` +
     `cache_read_input_tokens`/`cache_creation_input_tokens`).
   - `google.ts` — Gemini `usageMetadata`.
   - `index.ts` — `usageAdapterFor(model)` dispatcher based on protocol.

3. **Automatic collection** — `src/usage/collector.ts`
   `TokenUsageCollector.record()` called after every successful request
   (streaming and non-streaming) from `src/server.ts`.

4. **Streaming usage support** — `src/streaming.ts`
   - Capture usage from final chunk when the provider includes it.
   - Otherwise accumulate deltas and mark `estimated: true`.

5. **SQLite usage storage** — `src/usage/storage.ts`
   Schema + indexes per the plan; queries for session / provider / time-range.

6. **Usage query API** — new endpoints in `src/server.ts`:
   - `GET /usage/session?id=<session>` (also accepts `/usage/session/<id>`)
   - `GET /usage/providers?period=today|week|month|all`
   - `GET /usage/stats?period=...`

7. **CLI statistics command** — `agentx usage` (no `--provider`) prints token
   usage summary; `agentx usage --provider <id>` keeps the existing quota query.

8. **Cost calculation layer** — `src/usage/pricing/`
   `PricingProvider.calculate(model, usage)` per provider; not mixed with
   collection.

9. **Provider capability metadata** — `ProviderCapabilities` per provider
   (`supportsUsage`, `supportsStreamingUsage`, `supportsCacheTokens`).

10. **Tests** — unit (adapters, storage, collector, pricing) + integration
    (mock provider → collector → database → query API).

## Storage Schema

```sql
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_provider ON token_usage(provider);
CREATE INDEX idx_created ON token_usage(created_at);
```

## Notes

- SQLite is provided by Node's built-in `node:sqlite` (Node 22.5+/24). An
  in-memory fallback keeps tests environment-independent.
- The existing provider-quota query (`src/usage.ts`) is renamed to
  `src/quota.ts` to avoid clashing with the new `src/usage/` module directory.
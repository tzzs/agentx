# agentx

[![CI](https://github.com/tzzs/agentx/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/agentx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tzzs%2fagentx)](https://www.npmjs.com/package/@tzzs/agentx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Run Claude Code or Codex with OpenCode models through a local API adapter. Claude Code uses the local Anthropic-compatible Messages API; Codex uses the local OpenAI-compatible Responses API. The adapter translates requests to the upstream API, injects temporary credentials into the child process, and cleans up the local server when the child exits.

> **Status:** Early-stage release. The protocol conversion layer and test suite are available, but real upstream API compatibility should be validated with your OpenCode account before production use.

## Quick Start

Requirements:

- Node.js 20 or newer
- An OpenCode API key
- Claude Code installed and available as `claude` on `PATH`
- Codex installed and available as `codex` on `PATH` when using Codex

```bash
export AGENTX_OPENCODE_API_KEY="your-api-key"
npx agentx claude
```

The command starts a loopback-only adapter, waits for it to listen, launches Claude Code with temporary `ANTHROPIC_*` variables, forwards the terminal streams, and shuts the adapter down after Claude Code exits.

The real OpenCode key is never passed to Claude Code. Claude Code receives a random per-process local token instead.

Show credential setup instructions and status:

```bash
agentx auth login --provider deepseek
agentx auth status --provider deepseek
agentx auth logout --provider deepseek
```

Query provider quota where the upstream documents a quota endpoint:

```bash
agentx usage --provider deepseek
agentx usage --provider openrouter
```

Without `--provider`, `agentx usage` prints token usage statistics collected from
every request the adapter serves (see [Token Usage Statistics](#token-usage-statistics)):

```bash
agentx usage
agentx usage --period today
```

OpenCode currently reports an explicit unsupported result because it does not expose a documented public quota endpoint.

The `pi` client is also supported through the OpenAI-compatible environment:

```bash
agentx pi --provider openrouter --model anthropic/claude-sonnet-4
```

## Credentials and Profiles

Credentials come exclusively from environment variables: AgentX-specific variables are namespaced with the `AGENTX_` prefix (e.g. `AGENTX_OPENCODE_API_KEY`) so they never clash with same-named variables set for other tools; at runtime the value is injected into upstream requests as the plain key — the prefix exists only in the variable name. A legacy unprefixed variable (such as `OPENCODE_API_KEY`) is still picked up directly if it is already set. Resolution order: `--api-key`, `AGENTX_<PROVIDER>_API_KEY`, legacy `<PROVIDER>_API_KEY`, then an interactive prompt. When you type a key interactively, AgentX asks (default: yes) whether to save it as `AGENTX_<PROVIDER>_API_KEY` in your shell profile; declining keeps it valid for the current session only and prints instructions on how to persist it manually.

Non-secret provider profiles and model mappings are stored in `~/.config/agentx/profiles.json`; the default runtime per client and the last model per provider are stored in `~/.config/agentx/runtime.json`. API keys are never written to either file or to any AgentX-managed storage; with explicit consent they are appended to your shell profile.

## Providers

The adapter has three layers: a client layer for Claude Code/Codex, protocol adapters for Anthropic Messages and OpenAI Responses/Chat Completions, and a provider layer for upstream platforms.

Supported upstream providers:

| Provider | Credential (preferred) | Credential (legacy) | Example |
| --- | --- | --- | --- |
| OpenCode | `AGENTX_OPENCODE_API_KEY` | `OPENCODE_API_KEY` | `gpt-5.6-luna` |
| DeepSeek | `AGENTX_DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| OpenRouter | `AGENTX_OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` |

For scripts and advanced usage, `--provider`/`--model` override the configured runtime for a single invocation:

```bash
agentx claude --provider deepseek --model deepseek-v4-pro
agentx codex --provider openrouter --model anthropic/claude-sonnet-4
```

These flags are the Advanced / Automation API: ordinary day-to-day provider switching happens in the interactive runtime configuration. The equivalent environment variables are `AGENTX_PROVIDER` and `AGENTX_MODEL` (they also bypass the interactive launcher). Provider credentials are only used by the adapter and are never injected into the client process.

For Claude Code, the local token is injected as `ANTHROPIC_AUTH_TOKEN` rather than `ANTHROPIC_API_KEY`, matching provider integrations such as DeepSeek and avoiding Claude Code's custom API-key confirmation screen. The upstream key remains private to the adapter.

Every Claude Code model tier (main, opus/sonnet/haiku aliases, subagents) is pinned to the selected model — the user's choice is used for all traffic, including the small background requests Claude Code fires through its haiku tier (permission checks, topic detection, summarization). Optionally, `--background-model <id>` (or `AGENTX_BACKGROUND_MODEL`) routes just that background lane to another model the same provider serves — useful when the main model is a heavyweight reasoning model whose non-streaming auxiliary calls run past client timeouts. Requests naming a model the configured provider serves are honored as-is; unknown ids fall back to the configured model.

### Runtime configuration

When `claude`, `codex`, or `pi` is started on an interactive terminal without `--provider`/`--model` and without `AGENTX_PROVIDER`/`AGENTX_MODEL`, AgentX shows an interactive runtime launcher instead of requiring you to pick anything:

```
┌  Claude Code — AgentX
│
◆  Provider
│  ● OpenCode  (connected · 2 models)
│    DeepSeek  (connected · 2 models)
└
```

The current runtime is loaded from the saved default. Pick a provider, then a model, then choose to start now or to set the selection as the default. Switching provider automatically resolves a model for that provider and remembers the last model used on it. Temporary switches never overwrite the saved default unless you choose "Set as default and start". Non-interactive sessions skip the UI and resolve `--provider` → env vars → saved default → built-in defaults.

## Codex

Start Codex with an OpenAI-compatible local Responses endpoint:

```bash
npx agentx codex
npx agentx codex --model gpt-5.6-luna
```

The launcher passes `-c` overrides that define an inline `agentx` model provider pointing at `http://127.0.0.1:<port>/v1`, whose bearer token is the temporary local token injected as `OPENAI_API_KEY`. It also generates a model catalog (`~/.config/agentx/codex-models.json`, passed via `model_catalog_json`) so registry models resolve with real metadata instead of Codex's fallback-metadata warning. This works with current Codex releases (which no longer honor those environment variables) and skips Codex's sign-in screen entirely — no ChatGPT login or `~/.codex/auth.json` required, and your existing `~/.codex/config.toml` stays untouched. Codex can use both Responses and Chat Completions models: Responses models are passed through, while Chat Completions models are translated at the local Responses boundary. Claude Code and Codex can therefore use every model in the provider catalog.

## Installation

Use without installation:

```bash
npx agentx claude
```

Install globally:

```bash
npm install --global @tzzs/agentx
agentx claude
```

## Commands

### `claude`

Start the adapter and Claude Code together:

```bash
agentx claude
agentx claude --model deepseek-v4-flash
agentx claude --port 9000 --host 127.0.0.1
```

### `codex`

Start the adapter and Codex together. Codex is launched with `-c` overrides that point an inline model provider at the local adapter:

```bash
agentx codex
```

### `proxy`

Start only the local adapter. Press `Ctrl+C` to stop it:

```bash
agentx proxy
```

The local API is exposed at `http://127.0.0.1:<port>` and provides `GET /health`, `GET /v1/models`, `POST /v1/messages`, `POST /v1/responses`, plus the read-only token usage endpoints documented under [Token Usage Statistics](#token-usage-statistics).

### `exec`

Run any command with the temporary Anthropic environment:

```bash
agentx exec -- claude
agentx exec -- opencode
agentx exec -- my-command --argument
```

The command's stdin, stdout, stderr, exit code, and termination signals are forwarded where supported by the host platform.

### `doctor`

Inspect the local environment and configuration:

```bash
agentx doctor
```

The report includes Node.js, platform/WSL status, architecture, API key presence, supported models, and Claude Code discovery.

### `version`

```bash
agentx version
```

### `auth`

Show credential setup instructions and status (credentials live in environment variables; AgentX stores nothing itself):

```bash
agentx auth login --provider deepseek    # print setup instructions
agentx auth status --provider deepseek   # show current source and state
agentx auth logout --provider deepseek   # explain how to remove the variable
```

### `usage`

Print token usage statistics collected from every request the adapter serves:

```bash
agentx usage                 # all time
agentx usage --period today  # today / week / month / all
```

The report groups tokens by provider and model, shows input/output/total
counts, and includes an estimated cost based on provider pricing. Statistics
are stored per adapter run; the optional `--period` flag filters by time range.

With `--provider`, the command instead queries provider quota where the
upstream exposes a quota endpoint:

```bash
agentx usage --provider deepseek
agentx usage --provider openrouter
```

OpenCode currently reports an explicit unsupported result because it does not expose a documented public quota endpoint.

### `pi`

Launch Pi Agent through the OpenAI-compatible local environment:

```bash
agentx pi --provider openrouter --model anthropic/claude-sonnet-4
```

## Configuration

Config is resolved in this order:

1. Explicit CLI options (`--provider`, `--model`, `--api-key`, …)
2. Interactive temporary selection (only when no CLI/env override is present)
3. Saved default runtime for the client (from `runtime.json`)
4. Environment variables (`AGENTX_PROVIDER`, `AGENTX_MODEL`)
5. Built-in defaults (`opencode` / `gpt-5.6-luna`)

Only choosing "Set as default and start" in the interactive launcher persists a runtime change; a temporary switch affects the current invocation only.

| CLI option | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--api-key <key>` | `AGENTX_OPENCODE_API_KEY` (legacy `OPENCODE_API_KEY` also accepted) | none | OpenCode credential |
| `--host <host>` | `AGENTX_HOST` | `127.0.0.1` | Local bind address |
| `--port <port>` | `AGENTX_PORT` | `8787` | Preferred local port |
| `--model <model>` | `AGENTX_MODEL` | `gpt-5.6-luna` | Model or `auto` |
| `--provider <id>` | `AGENTX_PROVIDER` | none | Upstream provider (`opencode`, `deepseek`, `openrouter`) |
| `--verbose` | `AGENTX_LOG_LEVEL` | `info` | Reserved for verbose logging |
| | `AGENTX_USAGE_DIR` | `~/.config/agentx` | Directory for token usage statistics |

If the preferred port is already in use, the adapter tries subsequent ports. A non-loopback host is intentionally opt-in and should only be used on a trusted network:

```bash
agentx proxy --host 0.0.0.0
```

## Models and Routing

The OpenCode model catalog is fetched from `https://opencode.ai/zen/go/v1/models` on startup. When the endpoint cannot be reached, the built-in fallback catalog is used:

| Model | Upstream protocol |
| --- | --- |
| `gpt-5.6-luna` | Responses API |
| `deepseek-v4-pro` | Chat Completions API |
| `deepseek-v4-flash` | Chat Completions API |
| `minimax-m3`, `minimax-m2.7`, `minimax-m2.5` | Chat Completions API |
| `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5` | Chat Completions API |
| `glm-5.3`, `glm-5.2`, `glm-5.1`, `glm-5` | Chat Completions API |
| `mimo-v2.5-pro`, `mimo-v2.5`, `hy3` | Chat Completions API |

Models returned by the API use the Responses API (`gpt-5.6-luna`) or the Chat Completions API (everything else). `--model auto` still routes between a small set of known models, and the local `/v1/models` endpoint always reflects the current catalog.

The OpenRouter provider accepts any model id (defaulting to `OPENROUTER_MODEL` or `openai/gpt-4o-mini`).

Select a model explicitly:

```bash
agentx claude --model gpt-5.6-luna
```

With `--model auto`, short requests use `deepseek-v4-flash`, larger requests use `deepseek-v4-pro`, and requests containing tools or a large context use `gpt-5.6-luna`. This is a deliberately simple first-pass router, not a benchmark-based recommendation system.

## API Translation

The adapter does not persist conversation history. Claude Code sends the complete conversation on each request; the only local persistence is aggregated token usage statistics (see [Token Usage Statistics](#token-usage-statistics)).

Supported translation areas include:

- Anthropic `system` content to Responses `instructions` or a Chat Completions system message
- `max_tokens` to the upstream output-token limit
- Anthropic text messages and response text
- Anthropic streaming events to Anthropic SSE events
- Anthropic `tools`, `tool_use`, and `tool_result` to function tools and function call outputs
- Responses and Chat Completions usage data to Anthropic usage fields

The adapter translates tool protocols only. It does not execute tools and does not persist prompts, tool arguments, or conversation state.

## Token Usage Statistics

Every successful request is automatically measured and normalized into a
provider-independent `TokenUsage` record. Providers supply their own usage
adapters (`src/providers/usage/`) that map provider-specific fields into the
common format; the core runtime only ever sees `TokenUsage`.

Usage is persisted to a local SQLite database (via Node's built-in
`node:sqlite`) at `~/.config/agentx/usage.db`, with a JSON-file fallback when
`node:sqlite` is unavailable. Records store provider, model, input/output/
total tokens, cached and reasoning tokens, session id, and a timestamp.

### Streaming

For streaming responses the adapter captures usage from the provider's final
chunk when it is present. When the provider sends no usage, the adapter
accumulates deltas and marks the record as `estimated`.

### Query API

The adapter exposes read-only usage endpoints (no authentication):

| Endpoint | Description |
| --- | --- |
| `GET /usage/session?id=<session>` | Input/output/total tokens for one session |
| `GET /usage/providers?period=...` | Per-provider tokens and request counts |
| `GET /usage/stats?period=...` | Totals over a time range |

`period` accepts `today`, `week`, `month`, or `all`. Without a `period`, the
endpoints report all recorded usage. The session endpoint also accepts the
path form `GET /usage/session/<id>`.

### Cost Estimation

A pricing layer (`src/usage/pricing/`) converts token counts into an estimated
cost per provider. Collection and cost calculation are kept separate; the CLI
report uses the pricing layer only for display.

### Storage and Data

- Statistics live in `~/.config/agentx/usage.db` (or `usage.json` fallback).
- `AGENTX_USAGE_DIR` overrides the storage directory.
- Only token counts and metadata are stored — never prompts, tool arguments,
  or conversation content.

## Security and Privacy

- The upstream API key is read from the CLI or environment and sent only to OpenCode.
- Claude Code receives a random, non-persisted local bearer token for each adapter process.
- The default listener is `127.0.0.1`; no shell profile or permanent OS environment variable is modified.
- The `/usage/*` query endpoints are unauthenticated; they expose aggregated token counts only and are safe to reach from localhost, but do not expose them when the adapter is bound to a non-loopback interface.
- Logs must not contain API keys, authorization headers, prompts, or sensitive tool input.
- Treat `--host 0.0.0.0` as a deliberate network exposure and protect it with appropriate network controls.

## Platform Support

The launcher is designed for Linux, macOS, Windows, and WSL. WSL is detected using `WSL_INTEROP` and the local WSL Node.js process is used; the adapter does not depend on a Windows Node.js installation. Claude Code discovery supports the platform's normal executable resolution, including Windows shell execution.

## Development

```bash
git clone https://github.com/tzzs/agentx.git
cd agentx
npm ci
npm test
npm run build
```

The project uses TypeScript, native Node.js `fetch`, Node.js ESM, and the built-in `node:test` runner. Tests are compiled into `dist/test` before execution.

The test suite covers request/response conversion, system instructions, streaming events, tool calls, model routing, chat-completion conversion, token usage adapters, storage, pricing, and the usage query API. Tests do not require an API key or network access.

## CI and Publishing

GitHub Actions runs the build, tests, and package dry-run for every push and pull request against `main`. Release Please is configured in `.github/workflows/release-please.yml` and creates a release PR from conventional commits. Publishing is configured in `.github/workflows/publish.yml`:

1. Add an `NPM_TOKEN` secret to the `npm` GitHub environment.
2. Push a tag matching `v*.*.*`, or manually run **Publish package**.
3. The workflow runs the full test suite and publishes to `https://registry.npmjs.org` with provenance.

## Troubleshooting

**`OpenCode API key not found`**

Set `AGENTX_OPENCODE_API_KEY` (a previously set `OPENCODE_API_KEY` still works) or pass `--api-key <key>`. The key is required before the local server starts.

**`Claude Code was not found`**

Install Claude Code and ensure `claude` is available in the same shell's `PATH`, then run `agentx doctor`.

**`Codex not found: the "codex" command is not installed or not on PATH`**

When a client executable is missing, AgentX explains the problem and prints the recommended install command (for example, `npm install -g @openai/codex`). In an interactive terminal it also offers to run that command for you and relaunches the client after a verified install. Decline to install manually; re-run the same `agentx <client>` command afterwards.

**The port is busy**

The adapter automatically tries the next ports after the configured port. Use `--port` to choose another starting point.

**Upstream requests fail**

Run `agentx doctor`, verify the API key and model availability, and check network access to the OpenCode API. Do not paste API keys or authorization headers into issue reports.

## Contributing

Issues and pull requests are welcome. Keep changes focused, add or update tests for protocol behavior, run `npm test`, and avoid committing secrets or generated directories such as `dist` and `node_modules`.

## License

MIT © agentx contributors

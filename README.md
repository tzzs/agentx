# agentx

[![CI](https://github.com/tzzs/agentx/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/agentx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tzzs%2fagentx)](https://www.npmjs.com/package/@tzzs/agentx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Run Claude Code or Codex with OpenCode Go models through a local API adapter. Claude Code uses the local Anthropic-compatible Messages API; Codex uses the local OpenAI-compatible Responses API. The adapter translates requests to the upstream API, injects temporary credentials into the child process, and cleans up the local server when the child exits.

> **Status:** Early-stage release. The protocol conversion layer and test suite are available, but real upstream API compatibility should be validated with your OpenCode Go account before production use.

## Quick Start

Requirements:

- Node.js 20 or newer
- An OpenCode Go API key
- Claude Code installed and available as `claude` on `PATH`
- Codex installed and available as `codex` on `PATH` when using Codex

```bash
export OPENCODE_GO_API_KEY="your-api-key"
npx agentx claude
```

The command starts a loopback-only adapter, waits for it to listen, launches Claude Code with temporary `ANTHROPIC_*` variables, forwards the terminal streams, and shuts the adapter down after Claude Code exits.

The real OpenCode Go key is never passed to Claude Code. Claude Code receives a random per-process local token instead.

Manage stored credentials explicitly:

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

OpenCode Go currently reports an explicit unsupported result because it does not expose a documented public quota endpoint.

The `pi` client is also supported through the OpenAI-compatible environment:

```bash
agentx pi --provider openrouter --model anthropic/claude-sonnet-4
```

## Credentials and Profiles

On first use, the model/provider selector identifies the upstream provider and the adapter asks for its API key if it is not already available. Credentials are resolved in this order: `--api-key`, the provider environment variable, the OS credential store, then a hidden interactive prompt.

The optional `keytar` integration stores credentials in macOS Keychain, Windows Credential Manager, or Linux Secret Service. Non-secret provider profiles and model mappings are stored in `~/.config/agentx/profiles.json`; API keys are never written to that file. If a credential store is unavailable, the key is used for the current process only and a warning is shown.

## Providers

The adapter has three layers: a client layer for Claude Code/Codex, protocol adapters for Anthropic Messages and OpenAI Responses/Chat Completions, and a provider layer for upstream platforms.

Supported upstream providers:

| Provider | Credential | Example |
| --- | --- | --- |
| OpenCode Go | `OPENCODE_GO_API_KEY` | `gpt-5.6-luna` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| OpenRouter | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` |

Choose a provider explicitly when model names overlap:

```bash
agentx claude --provider deepseek --model deepseek-v4-pro
agentx codex --provider openrouter --model anthropic/claude-sonnet-4
```

The equivalent environment variable is `AGENTX_PROVIDER`. Provider credentials are only used by the adapter and are never injected into the client process.

For Claude Code, the local token is injected as `ANTHROPIC_AUTH_TOKEN` rather than `ANTHROPIC_API_KEY`, matching provider integrations such as DeepSeek and avoiding Claude Code's custom API-key confirmation screen. The upstream key remains private to the adapter.

When `claude` or `codex` is started without `--model` and without `AGENTX_MODEL`, an interactive arrow-key model selector is shown. The selected upstream model is printed in the startup banner and is also exposed as `AGENTX_MODEL` to the child process. Non-interactive sessions select the first/default catalog model.

## Codex

Start Codex with an OpenAI-compatible local Responses endpoint:

```bash
npx agentx codex
npx agentx codex --model gpt-5.6-luna
```

The launcher injects `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`, `OPENAI_API_KEY` with a temporary local token, and `OPENAI_MODEL`. Codex can use both Responses and Chat Completions models: Responses models are passed through, while Chat Completions models are translated at the local Responses boundary. Claude Code and Codex can therefore use every model in the provider catalog.

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

Start the adapter and Codex together. Codex receives OpenAI-compatible environment variables:

```bash
agentx codex
```

### `proxy`

Start only the local adapter. Press `Ctrl+C` to stop it:

```bash
agentx proxy
```

The local API is exposed at `http://127.0.0.1:<port>` and provides `GET /health`, `GET /v1/models`, `POST /v1/messages`, and `POST /v1/responses`.

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

## Configuration

CLI options take precedence over environment variables. The default model is `gpt-5.6-luna`.

| CLI option | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--api-key <key>` | `OPENCODE_GO_API_KEY` | none | OpenCode Go credential |
| `--host <host>` | `AGENTX_HOST` | `127.0.0.1` | Local bind address |
| `--port <port>` | `AGENTX_PORT` | `8787` | Preferred local port |
| `--model <model>` | `AGENTX_MODEL` | `gpt-5.6-luna` | Model or `auto` |
| `--verbose` | `AGENTX_LOG_LEVEL` | `info` | Reserved for verbose logging |

If the preferred port is already in use, the adapter tries subsequent ports. A non-loopback host is intentionally opt-in and should only be used on a trusted network:

```bash
agentx proxy --host 0.0.0.0
```

## Models and Routing

The built-in provider catalog currently contains:

| Model | Upstream protocol |
| --- | --- |
| `gpt-5.6-luna` | Responses API |
| `deepseek-v4-pro` | Chat Completions API |
| `deepseek-v4-flash` | Chat Completions API |

Select a model explicitly:

```bash
agentx claude --model gpt-5.6-luna
```

With `--model auto`, short requests use `deepseek-v4-flash`, larger requests use `deepseek-v4-pro`, and requests containing tools or a large context use `gpt-5.6-luna`. This is a deliberately simple first-pass router, not a benchmark-based recommendation system.

## API Translation

The adapter is stateless. Claude Code sends the complete conversation on each request; no conversation history is persisted locally.

Supported translation areas include:

- Anthropic `system` content to Responses `instructions` or a Chat Completions system message
- `max_tokens` to the upstream output-token limit
- Anthropic text messages and response text
- Anthropic streaming events to Anthropic SSE events
- Anthropic `tools`, `tool_use`, and `tool_result` to function tools and function call outputs
- Responses and Chat Completions usage data to Anthropic usage fields

The adapter translates tool protocols only. It does not execute tools and does not persist prompts, tool arguments, or conversation state.

## Security and Privacy

- The upstream API key is read from the CLI or environment and sent only to OpenCode Go.
- Claude Code receives a random, non-persisted local bearer token for each adapter process.
- The default listener is `127.0.0.1`; no shell profile or permanent OS environment variable is modified.
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

The test suite covers request/response conversion, system instructions, streaming events, tool calls, model routing, and chat-completion conversion. Tests do not require an API key or network access.

## CI and Publishing

GitHub Actions runs the build, tests, and package dry-run for every push and pull request against `main`. Release Please is configured in `.github/workflows/release-please.yml` and creates a release PR from conventional commits. Publishing is configured in `.github/workflows/publish.yml`:

1. Add an `NPM_TOKEN` secret to the `npm` GitHub environment.
2. Push a tag matching `v*.*.*`, or manually run **Publish package**.
3. The workflow runs the full test suite and publishes to `https://registry.npmjs.org` with provenance.

## Troubleshooting

**`OpenCode Go API key not found`**

Set `OPENCODE_GO_API_KEY` or pass `--api-key <key>`. The key is required before the local server starts.

**`Claude Code was not found`**

Install Claude Code and ensure `claude` is available in the same shell's `PATH`, then run `agentx doctor`.

**The port is busy**

The adapter automatically tries the next ports after the configured port. Use `--port` to choose another starting point.

**Upstream requests fail**

Run `agentx doctor`, verify the API key and model availability, and check network access to the OpenCode Go API. Do not paste API keys or authorization headers into issue reports.

## Contributing

Issues and pull requests are welcome. Keep changes focused, add or update tests for protocol behavior, run `npm test`, and avoid committing secrets or generated directories such as `dist` and `node_modules`.

## License

MIT © agentx contributors

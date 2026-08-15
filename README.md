# opencode-adapter

```bash
npx opencode-adapter claude
```

The adapter starts a local Anthropic Messages API, translates requests to OpenCode Go, and launches Claude Code with temporary environment variables.

Set `OPENCODE_GO_API_KEY` before use. The adapter keeps the real key local and gives Claude Code a temporary local token. It supports streaming, tool calls, `claude`, `proxy`, `exec`, `doctor`, and `version` commands.

Use `--model gpt-5.6-luna`, `--model deepseek-v4-pro`, `--model deepseek-v4-flash`, or `--model auto`. Configuration can be supplied with `OPENCODE_ADAPTER_HOST`, `OPENCODE_ADAPTER_PORT`, and `OPENCODE_ADAPTER_MODEL`, or the corresponding CLI flags. `doctor` reports platform, WSL, key, models, and Claude Code availability.

# opencode-adapter

```bash
npx opencode-adapter claude
```

The adapter starts a local Anthropic Messages API, translates requests to OpenCode Go, and launches Claude Code with temporary environment variables.

Set `OPENCODE_GO_API_KEY` before use. Phase 1 supports non-streaming requests with `claude`, `proxy`, `exec`, `doctor`, and `version` commands. Configuration can be supplied with `OPENCODE_ADAPTER_HOST`, `OPENCODE_ADAPTER_PORT`, and `OPENCODE_ADAPTER_MODEL`, or the corresponding CLI flags.

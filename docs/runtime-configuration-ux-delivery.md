# Runtime Configuration UX Redesign — Delivery Report

对应计划：`docs/plan/runtime-configuration-ux-redesign.md`

## 1. UX Changes

### 原来的用户动线

```text
agentx claude
  → 直接弹出 "Select OpenCode model" 列表
  → ← / ↓ 选择一个模型
  → Enter
  → 启动
```

每次启动（只要没有 `--model` / `AGENTX_MODEL`）都要求用户重新选择模型。Provider 与 Model 是两个脱节的全局概念，普通用户被迫理解底层参数。

### 新的用户动线

```text
agentx claude
  → 读取已保存的默认 runtime（per client）
  → 展示内联 Runtime Configuration：

      Claude Code — AgentX

      Provider  DeepSeek          ›
      Model     deepseek-v4-pro   ›

                [ Start ]            ← 默认焦点，Enter 直接启动

  → Enter → 启动（无需任何选择）
```

### Provider 如何选择

- Provider 行显示当前 runtime 的 provider，行尾 `›` 表示可操作。
- 将焦点移到 Provider 行（`↑`/`↓`），按 `Enter` / `Space` / `→` 打开 `Change Provider` 列表。
- 当前 provider 显示 `✓` 标记；已配置 provider 排在前面。
- 未配置的 provider 显示 `not configured`，选中后进入 API key 配置流程。
- 列表来自真实 provider registry，非硬编码。

### Model 如何选择

- Model 行显示当前 runtime 的 model。
- 打开 `Change Model` 后，列表根据当前 Provider 动态产生（不出现全局模型列表）。
- `● Auto` 置顶，保留 `--model auto` 的路由能力。

### 默认配置如何保存

- 在启动界面按 `s`（Set as default）将当前 runtime 保存为该 client 的默认配置。
- 每个 Provider 的最后一次使用的 model 会自动持久化（切换回来时恢复）。
- 持久化文件：`~/.config/agentx/runtime.json`（不含任何 API key）。

### 临时切换如何工作

- 用户在启动界面切换 Provider / Model 后直接 Enter 启动，**不会**覆盖默认配置。
- 启动横幅会提示 `Runtime: temporary selection (saves only with "Set as default")`。

### 永久切换如何工作

- 用户切换 Provider / Model 后按 `s`，可保存为默认配置。
- 之后 `agentx claude` 直接使用新默认配置启动。

## 2. Architecture Changes

| 模块 | 变更 |
| --- | --- |
| `src/runtime.ts` | **新增**。持久化 `defaults`（per-client 默认 runtime）与 `lastModels`（per-provider 最后 model），读写 `runtime.json`，不存密钥。 |
| `src/selection.ts` | **新增**。纯逻辑：`RuntimeDecision` 结构、`resolveRuntimeNonInteractive`（CLI > env > default > builtin 优先级）、`resolveModelForProvider`（last-model 恢复）、`modelAvailable`、`defaultModelFor`。 |
| `src/ui.ts` | **重写**。`runInteractiveLauncher`（内联 runtime 配置、三态焦点、Provider/Model selector、`s` 保存默认）、`chooseRuntime`（首次使用多 provider）、`configureProvider`（未配置 setup flow）、`providerEntries`。 |
| `src/cli.ts` | 集成 launcher。`resolveClientRuntime` 决定交互/自动化路径；missing-key 恢复流程；启动横幅提示临时/默认 runtime。 |
| `src/config.ts` | 支持 `--api-key`（kebab-case）读取。 |
| `README.md` | 更新 `--provider` 高级定位、运行时配置说明、优先级文档。 |

### Provider / Model / Runtime 如何关联

```text
Runtime Configuration
├── provider   → provider registry（真实来源）
└── model      → 按 provider 动态解析

Provider 切换 → 检查当前 model 是否属于新 provider
  ├── 还在 → 保留
  └── 不在 → 恢复该 provider 的 last-model / 默认 model
```

### 如何保存 per-provider last model

`runtime.json` 示例：

```json
{
  "defaults": {
    "claude": { "provider": "deepseek", "model": "deepseek-v4-pro" },
    "codex":  { "provider": "openrouter", "model": "anthropic/claude-sonnet-4" }
  },
  "lastModels": {
    "opencode": "gpt-5.6-luna",
    "deepseek": "deepseek-v4-pro",
    "openrouter": "anthropic/claude-sonnet-4"
  }
}
```

API key 继续使用 secure credential storage（keytar / 环境变量 / 交互输入），绝不清写入 `runtime.json` 或 `profiles.json`。

## 3. CLI Compatibility

以下命令全部保持兼容（已有测试或回归验证）：

```bash
agentx claude                                  # 交互 launcher，非交互走默认/环境/内置
agentx claude --provider deepseek              # 预选 provider
agentx claude --model deepseek-v4-flash        # 自动化路径
agentx claude --provider deepseek --model deepseek-v4-pro
agentx codex                                   # 同上
agentx codex --provider openrouter
agentx pi --provider openrouter --model anthropic/claude-sonnet-4
agentx proxy                                   # 启动本地 adapter
agentx exec [options] -- <command>
agentx doctor                                  # 诊断
agentx version
agentx help
agentx auth login --provider deepseek
agentx auth status --provider deepseek
agentx auth logout --provider deepseek
agentx usage --provider deepseek
agentx usage --provider openrouter
```

优先级：

```text
--provider / --model（CLI）
  → 环境变量 AGENTX_PROVIDER / AGENTX_MODEL
  → 保存的默认 runtime（per client）
  → 内置默认（opencode / gpt-5.6-luna）
```

交互临时切换只在不带显式 model 的 TTY 下出现，不会覆盖上述兼容语义。

## 4. Tests

新增 / 修改的测试文件：

| 文件 | 覆盖 |
| --- | --- |
| `test/runtime.test.ts` | runtime.json 路径、per-client 默认持久化、覆盖语义、per-provider last model、缺失返回 undefined |
| `test/selection.test.ts` | model 可用性、auto 保持、last-model 恢复、fallback 与保留、CLI/env/default/builtin 优先级、不同 client 不同默认、provider 切换自动重选 model |
| `test/ui.test.ts` | registry 来源的 provider 列表、configured 状态、非交互 launcher 透传、默认 model |

运行结果：

```text
npm test
ℹ tests 49
ℹ pass 49
ℹ fail 0
```

## 5. UX Screens / Interaction

### Scenario A — 首次运行，只有一个 Provider

```text
（只配置了 DeepSeek）
Claude Code — AgentX
  Provider  DeepSeek         ›
  Model     deepseek-v4-pro  ›
❯          [ Start ]
```
自动选择一个 provider，直接进入启动状态，无需确认。

### Scenario B — 首次运行，有多个 Provider

```text
Claude Code
Choose runtime
❯ OpenCode Go — connected · 18 models
  DeepSeek — connected · 2 models
```
在 `runInteractiveLauncher` 中调用 `chooseRuntime`，已配置 provider 优先；选中后进入内联配置界面。

### Scenario C — 已有默认 Provider，直接启动

```text
Claude Code — AgentX
❯ Provider  DeepSeek         ›
  Model     deepseek-v4-pro  ›
          [ Start ]
```
Enter 直接启动，无任何额外选择。

### Scenario D — 用户主动切换 Provider

```text
↓ → Provider 行 → → 打开 Change Provider
Change Provider
❯ ✓ DeepSeek — connected · 2 models
    OpenCode Go — not configured
```
选择新 provider 后，model 自动解析，回到内联配置界面。

### Scenario E — 切换回之前的 Provider，自动恢复之前 Model

```text
DeepSeek → deepseek-v4-pro（曾用）
切换到 OpenRouter → anthropic/claude-sonnet-4（曾用）
再切回 DeepSeek → 自动恢复 deepseek-v4-pro
```
`resolveModelForProvider` 优先返回该 provider 的 `lastModels` 记录。

### Scenario F — 用户临时切换 Provider，不修改默认

临时切换到 OpenRouter 并 Enter 启动；`runtime.json` 的 defaults 不变；启动横幅提示临时选择。

### Scenario G — 用户修改默认 Provider

切换 Provider 后按 `s`，`saveDefaultRuntime` 写入 `runtime.json`；之后 `agentx claude` 使用新默认。

### Scenario H — Provider 没有 API key

选中未配置 provider 后：

```text
OpenRouter
Not configured
API key required
Paste the API key and press Enter (Esc to cancel):
```
配置完成后 `✓ OpenRouter connected`，继续 model 选择。

### Scenario I — Provider / Model 不可用

启动时 API key 缺失会进入恢复流程（交互模式提供配置引导 / 非交互模式给出明确提示）。非交互时明确报错，可通过 `agentx auth login --provider <id>` 配置。

## 6. 最终设计原则落实

> AgentX 默认记住用户上一次/默认的 Runtime，让用户直接开始工作；只有用户主动操作 Provider 或 Model 时，才展示选择菜单。

- 默认启动 = `agentx claude` + Enter，零配置。
- Provider / Model 行提供 `›` affordance，用户直接理解可操作。
- 临时切换与默认配置严格分离（`s` 才保存）。
- 保留 `--provider` / `--model` / 环境变量等高级与自动化能力。

# AgentX Runtime Configuration UX Redesign — Final Implementation Prompt

你正在开发：

https://github.com/tzzs/agentx

请基于当前仓库最新代码，对 AgentX 的用户交互和配置体验进行一次系统性的 UX 重构。

本次目标不是简单增加一个 Provider Selector，而是重新设计 AgentX 的 Agent / Provider / Model / Configuration 用户动线，使其从一个偏底层的 CLI adapter，逐渐形成一个清晰、低认知负担的 Agent Runtime Launcher。

---

# 一、核心产品目标

AgentX 当前支持：

- Claude Code
- Codex
- Pi
- Proxy
- Exec
- Provider
- Model
- Auth
- Usage
- Doctor
- Auto routing

当前 Provider：

- OpenCode
- DeepSeek
- OpenRouter

当前已经支持：

- --provider
- --model
- AGENTX_PROVIDER
- AGENTX_MODEL

这些 CLI 能力必须保持兼容。

但是：

普通用户不应该被要求理解 --provider、--model、environment variable 等底层概念。

核心 UX 应该围绕：

“我要启动哪个 Agent，以及这次 Agent 使用哪个 Runtime”

而不是：

“我要填写 Provider 和 Model 参数”。

---

# 二、最重要的 UX 原则

必须遵守以下原则：

## 1. 默认配置自动填充

用户执行：

    agentx claude

如果已经存在默认配置：

    Claude Code
    Provider: OpenCode
    Model: gpt-5.6-luna

则直接使用该配置启动。

不要每次启动都要求用户重新选择 Provider。

---

## 2. Provider 不应该是每次启动的必选步骤

错误的设计：

    Choose Provider
    Choose Model
    Start

每次都重复。

正确：

    Claude Code

    Provider   OpenCode
    Model      gpt-5.6-luna

    Enter → Start

只有用户主动修改时，才进入 Provider / Model selection。

---

# 三、核心 UI：Inline Runtime Configuration

如果当前项目已经存在交互式/TUI 启动界面，请基于现有 UI 进行改造。

如果当前还没有对应 UI，请建立一个简洁的交互式启动界面。

目标结构：

    ╭────────────────────────────────────────────╮
    │ AgentX                                     │
    │                                            │
    │  Claude Code                               │
    │                                            │
    │  Provider    OpenCode              ›    │
    │  Model       gpt-5.6-luna             ›    │
    │                                            │
    │                          [ Start ]          │
    ╰────────────────────────────────────────────╯

其中：

    Provider    OpenCode    ›
    Model       gpt-5.6-luna   ›

表达的是：

“当前运行配置”

而不是：

“等待用户填写的表单”。

---

# 四、Provider 的修改交互

Provider 行必须支持用户主动打开 Provider selector。

至少支持：

- Enter / Space
- Right Arrow
- 鼠标点击（如果当前 TUI 框架支持）
- 右键 Context Menu（如果当前框架支持）

不要要求用户记忆类似：

    P = Change Provider

之类的快捷键。

快捷键可以作为辅助能力，但不能成为唯一入口。

---

## Provider Selector

用户点击：

    Provider   OpenCode   ›

之后：

    ┌──────────────────────────────┐
    │ Change Provider              │
    │                              │
    │ ✓ OpenCode                │
    │   DeepSeek                   │
    │   OpenRouter                 │
    │                              │
    │ ──────────────────────────── │
    │ Manage Providers...          │
    └──────────────────────────────┘

要求：

1. 当前 Provider 必须显示 selected 状态。
2. 已配置 Provider 优先显示。
3. 未配置 Provider 可以显示，但选择后应该进入 credential/setup flow。
4. Provider 列表必须来自真实 provider registry/configuration，而不是硬编码 UI。
5. 如果 Provider 不可用，应明确展示原因。
6. 如果没有任何 Provider 配置，则进入首次配置流程。

---

# 五、最重要的行为：Provider 切换后自动处理 Model

Provider 和 Model 存在父子关系：

    Provider
    └── Models

因此用户从：

    OpenCode
    gpt-5.6-luna

切换：

    DeepSeek

不能继续保留一个属于 OpenCode 的 model。

必须执行：

    Provider changed
            ↓
    检查当前 Model 是否属于新 Provider
            ↓
          ┌───────┐
          │       │
         Yes      No
          │       │
          ▼       ▼
      保留 Model   恢复/选择该 Provider 的 Model

---

# 六、每个 Provider 记住用户最后使用的 Model

这是本次设计的关键行为。

例如：

第一次：

    OpenCode
    → gpt-5.6-luna

之后切：

    DeepSeek
    → deepseek-v4-pro

再切回：

    OpenCode

应该自动恢复：

    OpenCode
    → gpt-5.6-luna

而不是要求用户重新选择。

因此配置模型需要支持：

    Provider preferences

    OpenCode
      lastModel: gpt-5.6-luna

    DeepSeek
      lastModel: deepseek-v4-pro

    OpenRouter
      lastModel: anthropic/claude-sonnet-4

这个状态应该持久化。

注意：

- 不要把 API key 写入普通 profile/config 文件。
- Provider credential 继续使用现有 secure credential storage。
- 复用当前项目已有的 profiles/configuration storage 能力。
- 不要引入重复的配置系统。

---

# 七、Provider + Model 应该形成一个 Runtime 概念

虽然 UI 中可以分别显示：

    Provider
    Model

但是内部设计应该明确：

    Runtime Configuration
    ├── provider
    └── model

例如：

    Claude Code
    └── Runtime
        ├── Provider: DeepSeek
        └── Model: deepseek-v4-pro

不要把 Provider 和 Model 设计成两个完全独立的全局配置。

因为：

    DeepSeek → deepseek-v4-pro
    OpenRouter → anthropic/claude-sonnet-4
    OpenCode → gpt-5.6-luna

实际上是用户真正选择的 Runtime。

---

# 八、默认配置与临时切换必须分离

必须明确区分：

## A. 临时切换

用户在启动界面：

    Provider → OpenRouter

意味着：

“本次运行使用 OpenRouter。”

不要自动覆盖默认配置。

例如默认：

    Claude Code
    → DeepSeek
    → deepseek-v4-pro

本次临时选择：

    Claude Code
    → OpenRouter
    → anthropic/claude-sonnet-4

退出后默认仍然：

    Claude Code
    → DeepSeek
    → deepseek-v4-pro

---

## B. 修改默认配置

用户需要显式执行类似：

    Set as default

之后才修改默认配置。

例如：

    Change Provider
        ↓
    OpenRouter
        ↓
    Set as default

之后：

    agentx claude

默认才变成 OpenRouter。

---

# 九、Provider Context Menu

Provider 的 Context Menu 建议包含：

    ┌──────────────────────────────┐
    │ Change Provider              │
    │                              │
    │ ✓ OpenCode                │
    │   DeepSeek                   │
    │   OpenRouter                 │
    │                              │
    │ ──────────────────────────── │
    │ Set as default               │
    │ Manage Providers...          │
    └──────────────────────────────┘

注意：

“Change Provider”与“Set as default”语义必须清晰。

如果当前页面本身已经代表默认配置，则可以简化交互，但不能出现：

用户只是想临时切换 Provider，却意外修改了默认配置。

---

# 十、Model Selector

Model 也采用同样的 inline interaction：

    Model   gpt-5.6-luna   ›

点击：

    ┌──────────────────────────────┐
    │ Change Model                 │
    │                              │
    │ ✓ gpt-5.6-luna               │
    │   deepseek-v4-pro            │
    │   deepseek-v4-flash          │
    │                              │
    │ ──────────────────────────── │
    │ Browse all models...         │
    └──────────────────────────────┘

Model 列表必须根据当前 Provider 动态产生。

不要创建一个全局 model list 后再让用户自己理解哪个 Provider 支持哪个模型。

---

# 十一、Auto Model

当前 AgentX 已经支持：

    --model auto

应该保留。

但是 UI 中不要把 Auto 当成普通 model。

显示：

    Model

    ● Auto
      deepseek-v4-pro
      deepseek-v4-flash
      ...

可以给 Auto 一个简短描述：

    Automatically choose a suitable model

当前已有 routing 逻辑不要破坏。

---

# 十二、多 Provider 的首次使用流程

假设用户已经配置：

    OpenCode
    DeepSeek
    OpenRouter

但 Claude Code 还没有默认 runtime。

用户：

    agentx claude

应该：

    Claude Code

    Choose runtime

    ❯ OpenCode
      DeepSeek
      OpenRouter

如果需要选择 model：

    Choose model

    ❯ gpt-5.6-luna

然后：

    Claude Code

    Provider   OpenCode
    Model      gpt-5.6-luna

    Use this as default?

    ❯ Yes
      No

建议默认选择 Yes，但必须尊重当前已有配置逻辑。

---

# 十三、如果只有一个 Provider

如果用户只有：

    DeepSeek

不要强制出现：

    Choose Provider

应该自动：

    Provider   DeepSeek
    Model      deepseek-v4-pro

直接进入启动状态。

原则：

“能自动推断的东西，不要让用户选择。”

---

# 十四、Provider 尚未配置时

例如用户选择：

    OpenRouter

但是没有 credential。

不要直接报：

    OPENROUTER_API_KEY not found

应该进入：

    OpenRouter

    Not configured

    API key required

    [ Configure ]
    [ Cancel ]

配置完成：

    ✓ OpenRouter connected

然后继续：

    Choose model

---

# 十五、Provider 管理

应该有一个独立的 Provider Management flow。

例如：

    AgentX

    Providers

    ● OpenCode
      Connected
      5 models

    ● DeepSeek
      Connected
      2 models

    ○ OpenRouter
      Not configured

进入 Provider：

    DeepSeek

    Status       Connected
    Credential   ●●●●●●●●
    Models       2

    [ Test Connection ]
    [ Change Credential ]
    [ Refresh Models ]
    [ Usage ]
    [ Remove ]

复用当前：

- auth
- usage
- provider registry
- credential storage
- model catalog

不要重复实现一套 credential 系统。

---

# 十六、Auth 的 UX 重新定位

现有 CLI：

    agentx auth login --provider deepseek
    agentx auth status --provider deepseek
    agentx auth logout --provider deepseek

必须保持兼容。

但在产品 UX 中：

Auth 是 Provider 的一个子能力。

用户应该理解：

    Providers
    └── DeepSeek
        ├── Credentials
        ├── Models
        ├── Usage
        └── Connection

而不是：

    Auth
    └── DeepSeek

---

# 十七、Usage 的 UX 重新定位

当前：

    agentx usage --provider deepseek

保持兼容。

但是 UI 上：

    Providers
    └── DeepSeek
        └── Usage

例如：

    DeepSeek

    Usage

    Today       42%
    This month  ...

如果 provider 没有公开 quota endpoint，必须明确：

    Usage unavailable

    This provider does not expose a documented usage endpoint.

不要伪造数据。

---

# 十八、Profile / Configuration

如果当前代码已有 profile 机制，应该继续扩展。

建议内部概念：

    Profile
    ├── client
    ├── provider
    ├── model
    └── options

例如：

    {
      "client": "claude",
      "provider": "deepseek",
      "model": "deepseek-v4-pro"
    }

但是 UI 不一定需要强制向普通用户暴露 “Profile” 这个词。

可以叫：

    Configuration

例如：

    Configurations

    ★ Claude Code
       DeepSeek · deepseek-v4-pro

      Claude Code
       OpenRouter · anthropic/claude-sonnet-4

      Codex
       OpenRouter · gpt-5

如果当前项目已经有成熟的 profile storage，请优先复用。

---

# 十九、不同 Agent 的默认配置

支持：

    Claude Code → DeepSeek → deepseek-v4-pro

    Codex → OpenRouter → anthropic/claude-sonnet-4

    Pi → OpenCode → gpt-5.6-luna

因此不要简单设计：

    defaultProvider
    defaultModel

因为未来不同 Agent 很可能需要不同默认 Runtime。

应该至少支持：

    client → runtime configuration

例如：

    {
      "defaults": {
        "claude": {
          "provider": "deepseek",
          "model": "deepseek-v4-pro"
        },
        "codex": {
          "provider": "openrouter",
          "model": "anthropic/claude-sonnet-4"
        }
      }
    }

具体数据结构根据现有项目架构决定，不要为了这个需求大规模重构。

---

# 二十、CLI `--provider` 必须保留

不要删除：

    agentx claude --provider deepseek

不要破坏：

    AGENTX_PROVIDER

CLI precedence 继续保持。

建议最终优先级：

    Explicit CLI arguments
            ↓
    Interactive temporary selection
            ↓
    Saved/default configuration
            ↓
    Environment variables
            ↓
    Built-in defaults

但必须结合当前代码实际 precedence 设计，不能简单改变现有兼容行为。

如果当前环境变量优先级已经有稳定的公开语义，则需要兼容并通过测试保证。

---

# 二十一、`--provider` 的产品定位

`--provider` 继续保留。

但是：

`--provider` 是 Advanced / Automation API，而不是普通用户的主要 Provider switching UI。

README / help 中可以说明：

    --provider <provider>
        Override the configured provider for this invocation.
        Useful for scripts and advanced usage.

普通用户主要通过交互式 runtime configuration 切换。

---

# 二十二、启动界面必须尽量“零认知负担”

理想状态：

第一次：

    agentx claude

↓

    Claude Code

    Provider   DeepSeek
    Model      deepseek-v4-pro

    Enter Start

以后：

    agentx claude

↓

    Claude Code

    Provider   DeepSeek
    Model      deepseek-v4-pro

    Enter Start

用户完全不需要重新配置。

如果想换：

    Provider   DeepSeek   ›

点击 / Enter / Right Arrow / 右键。

↓

    OpenCode
    DeepSeek
    OpenRouter

选择。

↓

自动恢复对应 Provider 的 last model。

---

# 二十三、不要强制增加复杂菜单

不要为了实现上述功能强制加入：

    P = Provider
    M = Model
    R = Runtime
    C = Configuration
    D = Default

大量快捷键。

UI 本身应该提供 affordance。

例如：

    Provider   DeepSeek       ›
    Model      deepseek-v4-pro ›

用户应该能够直接理解：

“这里可以操作。”

快捷键可以存在，但应该是辅助功能。

---

# 二十四、启动流程最终应该类似

    agentx claude
            │
            ▼
    Load saved configuration
            │
            ▼
    ┌───────────────────────────┐
    │ Claude Code               │
    │                           │
    │ Provider  DeepSeek     ›  │
    │ Model     V4 Pro       ›  │
    │                           │
    │              [ Start ]    │
    └───────────────────────────┘
            │
            ├── Enter
            │     ↓
            │   Start
            │
            ├── Provider
            │     ↓
            │   Provider selector
            │     ↓
            │   Restore last model
            │
            └── Model
                  ↓
                Model selector

---

# 二十五、Proxy / Exec / Doctor 的 UX

不要把所有 command 都塞进同一个 user-facing flow。

语义应该区分：

## Run Agent

    Claude Code
    Codex
    Pi

## Advanced / Developer

    Proxy
    Exec
    Doctor

其中：

### Proxy

代表：

Start local API adapter.

### Exec

代表：

Run another command through AgentX environment.

### Doctor

代表：

Diagnose AgentX environment / configuration.

不要把这些和 Provider selection 混为一谈。

---

# 二十六、错误恢复

启动失败时不要只输出底层错误。

例如：

    Failed to connect to DeepSeek

应该尽可能提供：

    DeepSeek connection failed

    Possible causes:
      • Invalid API key
      • Model unavailable
      • Network unavailable

    [ Retry ]
    [ Change Provider ]
    [ Configure Provider ]
    [ Run Diagnostics ]

如果当前 UI framework 不支持按钮，则提供对应键盘操作。

重要：

错误状态必须允许用户直接回到 Provider selection，而不是退出 AgentX 重新开始。

---

# 二十七、代码实现要求

开始修改前：

1. 阅读完整项目结构。
2. 找出当前：
   - CLI entry
   - command definitions
   - provider registry
   - model catalog
   - profile/config storage
   - credential storage
   - interactive selector
   - launcher
   - environment injection
3. 判断项目当前是否已经存在 TUI / interactive UI。
4. 优先复用现有架构。
5. 不要因为 UX 重构直接重写 provider adapter / protocol adapter。
6. 不要破坏现有 CLI API。

---

# 二十八、数据层要求

确保以下状态可以持久化：

    default runtime per client
    last model per provider
    provider credentials
    provider configuration

但：

API key / secret 永远不能写入普通 profiles.json 或其他明文配置。

继续使用现有 secure credential storage。

如果 secure storage 不可用，则遵循当前项目已有的 ephemeral credential fallback。

---

# 二十九、兼容性

必须保持：

    agentx claude
    agentx codex
    agentx pi
    agentx proxy
    agentx exec
    agentx doctor
    agentx version
    agentx auth
    agentx usage

正常工作。

尤其保持：

    agentx claude --provider deepseek
    agentx claude --model deepseek-v4-pro
    agentx codex --provider openrouter
    agentx pi --provider openrouter --model anthropic/claude-sonnet-4

继续可用。

---

# 三十、测试要求

新增/修改测试覆盖：

## Provider selection

- 单 Provider 自动选择
- 多 Provider 首次选择
- Provider 切换
- Provider 不存在
- Provider 未配置
- Provider unavailable

## Model selection

- Provider 切换后 Model 自动变化
- 当前 Model 在新 Provider 中仍可用
- 当前 Model 不可用时重新选择
- Provider last-model 恢复
- auto 保持工作

## Defaults

- 默认配置加载
- 临时 Provider selection 不修改默认配置
- Set as default 修改默认配置
- 不同 client 拥有不同默认 runtime

## CLI

- --provider compatibility
- --model compatibility
- environment variable compatibility
- CLI override precedence

## Credentials

- provider credential 不写入 profile
- credential store 正常
- credential 缺失时进入 setup flow

---

# 三十一、最终交付要求

完成后输出：

## 1. UX Changes

详细说明：

- 原来的用户动线
- 新的用户动线
- Provider 如何选择
- Model 如何选择
- 默认配置如何保存
- 临时切换如何工作
- 永久切换如何工作

## 2. Architecture Changes

说明：

- 哪些模块修改
- 新增哪些 configuration/profile abstraction
- Provider / Model / Runtime 如何关联
- 如何保存 per-provider last model

## 3. CLI Compatibility

列出所有保持兼容的 CLI：

    agentx claude
    agentx claude --provider ...
    agentx claude --model ...
    ...

## 4. Tests

列出新增/修改的测试以及测试结果。

## 5. UX Screens / Interaction

至少给出以下场景的实际交互：

### Scenario A

首次运行，只有一个 Provider。

### Scenario B

首次运行，有多个 Provider。

### Scenario C

已有默认 Provider，直接启动。

### Scenario D

用户主动切换 Provider。

### Scenario E

用户切换回之前的 Provider，自动恢复之前 Model。

### Scenario F

用户临时切换 Provider，不修改默认。

### Scenario G

用户修改默认 Provider。

### Scenario H

Provider 没有 API key。

### Scenario I

Provider / Model 不可用。

---

# 三十二、最终设计原则

整个实现必须围绕以下一句话：

AgentX 应该默认记住用户上一次/默认的 Runtime，让用户直接开始工作；只有用户主动操作 Provider 或 Model 时，才展示选择菜单。

核心 UI：

    Claude Code

    Provider   OpenCode             ›
    Model      gpt-5.6-luna            ›

    Enter → Start

用户主动操作：

    Provider
       ↓
    Change Provider
       ↓
    OpenCode
    DeepSeek
    OpenRouter

切换后：

    DeepSeek
       ↓
    自动恢复 deepseek-v4-pro

默认配置：

    Claude Code
    → DeepSeek
    → deepseek-v4-pro

临时切换：

    Claude Code
    → OpenRouter
    → anthropic/claude-sonnet-4

退出后默认仍然：

    Claude Code
    → DeepSeek
    → deepseek-v4-pro

只有明确执行：

    Set as default

才改变默认配置。

最终目标：

隐藏配置复杂度，保留完整控制能力。

普通用户无需理解 --provider，高级用户和脚本仍然可以使用 --provider。

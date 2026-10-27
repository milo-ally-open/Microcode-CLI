# 行为规格：Microcode 运行时架构重构

> 关联提案：[proposal.md](proposal.md)<br>
> 设计：[design.md](design.md)<br>
> 贡献指南：[model-provider-guide.md](model-provider-guide.md)、[tool-extension-guide.md](tool-extension-guide.md)<br>
> Gateway 协议能力审计：[protocol-capability-matrix.md](protocol-capability-matrix.md)<br>
> 上游 provider 能力矩阵：[provider-capability-matrix.md](provider-capability-matrix.md)<br>
> 本文是重构目标的权威合同。现有实现及旧版本行为以代码和 [模型集成规范](../model_intergration_spec.md) 为证据；与本规格冲突的旧 provider/auth 范围在迁移完成后不再作为目标。

## 范围和术语

- **内核层（Kernel）**：pi-agent-core 与 pi-ai 的当前适配实现；未来可用其他内核实现替换。
- **Microcode 运行时**：Agent 会话、提示词、上下文、压缩、权限、模型选择、工具生命周期、Skills/MCP/Plugin 协调和持久化。
- **模型接入层**：以稳定 provider adapter 合同向运行时提供模型目录、认证能力与推理流。
- **工具接入层**：以稳定 tool definition 合同向运行时提供 schema、执行、权限元数据和 UI 语义投影。
- **能力拓展层**：现有 Skill、MCP、Plugin 包及其来源/启用/信任/权限行为，继续由已通过的专属规范定义。
- **UI 层**：只持有展示状态、终端输入和 runtime client；不直接创建内核 Agent 或 provider。
- **客户端协议**：兼容性 Model Gateway 接收的 OpenAI Chat Completions、OpenAI Responses、Gemini Generate Content 或 Anthropic Messages 请求。它不同于上游 provider 调用 Pi 的 API 类型。
- **代码扩展模块**：在构建产物中静态注册的受信 TypeScript provider/tool adapter。安装的 Plugin 包不提供可执行 JS。

## 需求与验收条件

### REQ-01：层边界与可替换内核

**需求**：Microcode 必须通过内核 adapter 使用 Pi。运行时领域接口不向 TUI 或业务 capability 泄漏 Pi 的 Agent、Model、Models 或消息事件类型。

**验收条件**

- **AC-01.1** 新内核接入或替换仅需实现 kernel contract；Agent runtime、TUI 与 Skills/MCP/Plugin 公共合同不直接依赖 Pi 类型。
- **AC-01.2** Bun 服务边界上的命令、状态与事件使用显式版本化的可序列化 DTO；没有 Pi 实例、函数或 credential 经过 transport。客户端不需要的内核转录内容不得随命令响应返回，例如 compaction 只返回结果摘要和计数，不返回消息数组。
- **AC-01.3** 当前 kernel adapter 对应的 pi-ai 与 pi-agent-core 版本可从 package.json 和 bun.lock 明确追溯。

**验证方式**：静态 import 边界扫描、类型检查、adapter contract tests。

### REQ-02：Microcode Agent runtime

**需求**：单一 Microcode runtime owner 管理一个 Agent 会话的消息循环、prompt、模型选择、权限、上下文压缩、会话存储和生命周期事件。

**验收条件**

- **AC-02.1** runtime API 覆盖 prompt、steer、follow-up、abort、wait、model/thinking 修改、session resume、compaction 和状态快照。
- **AC-02.2** 每次工具执行都经过 runtime PermissionManager；客户端提供的事件或 tool result 不能绕过许可判定。
- **AC-02.3** 重构不创建 Agent swarm、worker orchestration 或第二种会话核心。

**验证方式**：runtime contract tests、权限路径代码审查、session resume acceptance。

### REQ-03：可扩展且有白名单的模型接入

**需求**：模型 provider adapter 必须可单独注册和审查；模型目录与认证只开放已批准 provider。初始 provider/auth 组合为 OpenAI Codex OAuth、OpenAI GPT API Key、DeepSeek API Key。

**验收条件**

- **AC-03.1** 默认模型集合只公开 provider ID openai-codex、openai、deepseek；OpenAI Codex 只提供 OAuth，OpenAI 与 DeepSeek 只提供 API Key 登录/环境变量入口。
- **AC-03.2** 未列入白名单的 Pi provider 和旧自定义 model 配置不得成为可选模型或可发起推理的 model；旧数据保持原样并显示可操作诊断。
- **AC-03.3** 增加一个 provider 可经静态注册模块完成；重复 ID、未声明认证方式或不支持协议的注册在启动/注册时失败并说明原因。
- **AC-03.4** 认证凭据只存在服务端的 CredentialStore/auth provider 路径；目录、协议错误、日志和 client DTO 不包含密钥或 OAuth token。

**验证方式**：provider registry contract tests、锁定 Pi package 测试、无真实 vendor OAuth 的认证 fixture。

### REQ-04：协议兼容与模型调用分离

**需求**：Model Gateway 将客户端协议解析为 Microcode 内部请求，再经模型接入层调用选定 provider；provider 的上游 API 与客户端协议独立选择。

**验收条件**

- **AC-04.1** Model Gateway 提供 OpenAI Chat Completions、OpenAI Responses、Gemini Generate Content、Anthropic Messages 四种协议的明示版本/路由。
- **AC-04.2** 四种协议的非流与流式路径都映射同一规范化 message、tool-call、usage、stop/error 和 cancellation 语义；不支持的 modality 或请求参数返回明确错误。
- **AC-04.3** provider/model 唯一解析；模糊、未知或被白名单禁用的模型请求不回退到其他模型。
- **AC-04.4** 外部 Gateway 仅返回模型文本、推理字段（仅在协议与 provider 都明确支持时）、tool call 和 usage；它不执行 tool call、不载入 workspace、不进入 TUI session。
- **AC-04.5** 各协议的工具调用 round trip、SSE/流事件顺序、错误和取消使用固定 fixture；上线协议支持前记录实际测试客户端及版本。

**验证方式**：协议 parser/serializer contract tests、HTTP fixture tests、注明版本的手动 client smoke。

### REQ-05：工具插件合同与运行时变更

**需求**：工具应实现独立、统一的 adapter contract；Agent 可在运行时切换其已注册且已批准的工具集合。

**验收条件**

- **AC-05.1** 每项工具有唯一稳定 ID、schema、描述、执行入口、默认权限和可选 UI 投影；工具输出与 TUI 呈现保持工具呈现规范中的分离。
- **AC-05.2** Agent 只能启用或停用服务端已经注册且允许此会话使用的工具，不允许 eval、动态 import 任意代码或改写权限规则。
- **AC-05.3** 工具集变更以一个原子、递增的 snapshot 应用于后续请求；在途 tool call 使用已开始时的实现，状态事件可让 TUI 更新。
- **AC-05.4** 新启用的工具仍经过 PermissionManager；拒绝、ask、取消与失败语义由原权限规范处理。
- **AC-05.5** 首个默认工具集合只包含提案中确认的基础集合；额外工具可通过独立注册模块启用，Git/worktree 和一般任务管理仍作为独立可选能力。
- **AC-05.6** Agent/runtime 工具注册入口不导入 `pi-tui` 或工具 `UI.tsx`；TUI presentation 通过稳定 tool ID 独立关联，缺少展示组件不能阻止后端注册和执行工具。

**验证方式**：tool registry/runtime contract tests、动态变更期间的 permission tests、TUI event projection review。

### REQ-06：Skill、MCP、Plugin 保持独立能力层

**需求**：重构必须保留既有 Skill、standalone MCP、Plugin 的配置、发现、来源、scope、校验、连接、权限与启用约定。

**验收条件**

- **AC-06.1** Skill/MCP source precedence、reserved IDs、legacy MCP 配置和 system managed assets 继续遵循 [系统能力规范](../system_capabilities_spec.md)。
- **AC-06.2** Plugin 仍组合 Skill/MCP package；Plugin 的 MCP tool call 继续遵循 PermissionManager；安装 Plugin 不会执行任意 JS。
- **AC-06.3** UI 只通过 runtime command/event 管理 capability；MCP 生命周期和 secret redaction 留在服务端。

**验证方式**：现有 Skills/MCP/Plugin contract tests 和端到端 runtime event review。

### REQ-07：Bun 服务端与 TUI 客户端分离

**需求**：常规 CLI/TUI 启动时，Bun 后端服务持有 Agent/runtime，TUI 客户端通过版本化 transport 发送命令和消费事件。

**验收条件**

- **AC-07.1** TUI 启动路径不再创建 Agent、SessionManager、McpClientManager、PluginManager 或 provider collection；这些由后端初始化。
- **AC-07.2** 服务端握手协商协议版本；command 带 request ID，event 带 session ID 与单调递增序号，重连可恢复或请求完整状态快照。
- **AC-07.3** 本地 runtime API 只绑定回环地址并使用独立随机 token；其 token 和管理命令不复用可配置 bind 的外部 Gateway token。
- **AC-07.4** 权限确认、问题回答、取消、输入和工具/模型状态更新均由同一 event/command 合同往返。
- **AC-07.5** Chalk TUI 可断线重连、显示服务错误和恢复状态；UI 不伪造服务端权限、会话或 tool status。
- **AC-07.6** no-daemon 保留明确的进程内 Pi 路径；默认连接失败可见并按文档定义的策略处理，不会静默降低安全边界。

**验证方式**：客户端/服务器 transport contract tests、进程启动/重连/退出集成检查。

### REQ-08：配置、session 与增量贡献

**需求**：分阶段迁移必须可回退；模型和工具的新贡献必须能由独立 GitHub feature 检查。

**验收条件**

- **AC-08.1** session JSONL schema 与既有会话读取保持兼容；服务端拥有唯一 session writer。
- **AC-08.2** 不支持的旧 provider/config 不被静默删除；服务给出 provider/model 名和迁移指引但不回显 credential。
- **AC-08.3** 每个 feature task 只需实现一个 registry adapter，覆盖 feature 自己的 tests/ 目录与文档，无需修改 TUI 核心或 Agent loop。
- **AC-08.4** [模型接入指南](model-provider-guide.md)与[工具接入指南](tool-extension-guide.md)列出必要源码、接口、测试、兼容和 review 步骤。

**验证方式**：旧 session fixture、独立 adapter contribution walkthrough、文档审查。

## 不变项与兼容要求

- TypeScript 全栈与 Bun 运行时。
- Microcode 保持单 Agent coding assistant；没有 GUI 或 Agent swarm。
- no-daemon 仍直接使用进程内 Pi runtime。
- session JSONL、permission modes、Skill/MCP/Plugin 数据及已有 Gateway bind 配置不做破坏性迁移。
- 外部 Model Gateway 当前的 loopback 默认值、host/port precedence 与公开安全限制继续遵循 [模型集成规范](../model_intergration_spec.md) 及 AGENTS.md。
- credential secrets 不进入 TUI 事件流、日志、协议错误或模型清单。

## 数据处理和保留

- runtime DTO 只传会话 ID、消息、工具/模型元数据、权限选择及服务状态。绝不传 Pi 实例、provider secret、OAuth token 或 MCP env/headers secret。
- 当前加密凭据保持在服务端用户存储；未批准 provider 的旧凭据不被使用或删除。credential migration 需未来单独任务定义。
- session JSONL 继续由服务端 SessionManager 持久化；重构第一阶段不改变 schema。
- 命令去重与事件 replay 使用有限内存窗口，生命周期随 daemon 进程结束；session transcript 是恢复会话的权威数据，不是 UI event log。

## 明确不做

- 本地或远程动态执行用户提供的 JS/TS/native/WASM 工具。
- 外部 Gateway 替客户运行 Microcode 工具、读取项目文件或保存默认 prompt。
- 让模型 provider 插件改变权限配置、覆盖别的 provider ID 或导出 credential。
- 增加多 Agent orchestration、web UI、hosted SaaS、多租户或远程账户服务。

## 需求追踪

| 上游条款 | REQ | 模块/服务 | 任务 ID | AC | 验收证据/状态 |
|---|---|---|---|---|---|
| 用户架构第 1、2 层 | REQ-01 / REQ-02 | src/kernel、src/agent、src/daemon/runtime | T-02 | AC-01.1 至 AC-02.3 | Kernel/Pi adapter 与 Pi-free runtime transport DTO 已建立；MicrocodeAgent core 的消息、模型、compaction 与 kernel 调用经通用 adapter 注入，仍待活动 RuntimeAgentSession 使用 kernel-neutral composition 的跨进程验收 |
| 用户模型最小支持与 feature 演进 | REQ-03 | src/models/providers、src/models/registry、src/models/runtime.ts | T-03 | AC-03.1 至 AC-03.4 | 三个 provider allowlist 与 kernel-neutral model runtime/inference DTO 已建立，Pi 转换集中在 kernel adapter，provider capability matrix 已记录锁定 catalog；auth/stream 端到端验收待完成 |
| 用户模型协议清单 | REQ-04 | src/daemon/protocol、src/daemon/server | T-04 | AC-04.1 至 AC-04.5 | 四种协议路由、unary parser/serializer、SSE adapter 和 capability/error matrix 已存在并按协议拆分；固定协议 fixture 与版本化 client smoke 仍待验收 |
| 用户工具接入及运行时修改 | REQ-05 | src/tools、src/agent/AgentToolManager | T-05 | AC-05.1 至 AC-05.6 | 静态 registry、runtime mutation 与受保护工具控制已实现；presentation import boundary 已拆分，服务端版本冲突与 TUI 事件验收待做 |
| 用户明确保留能力系统 | REQ-06 | src/skill、src/mcp、src/plugins | T-06 | AC-06.1 至 AC-06.3 | Runtime child 持有能力发现、连接及 enable/refresh 命令；TUI 默认路径使用安全摘要 DTO，能力规范回归验收待做 |
| 用户 UI/服务端前后端分离 | REQ-07 | src/daemon、src/tui、src/main.tsx | T-07 / T-08 | AC-07.1 至 AC-07.6 | 默认 main path 使用 launcher、HTTP/SSE client 与 runtime facades；transcript/event/current-model/model-catalog/auth DTO 已与 Pi 分离，标题建议走 Runtime 命令，UI 重连提示已接入；auth prompt 往返与交互/子进程 smoke、完整 view contract 验收待做 |
| 用户要求持续演进和兼容 | REQ-08 | tests、docs/specs/runtime-architecture | T-01 / T-09 | AC-08.1 至 AC-08.4 | 文档完成；运行时待实施 |

## 假设与未决问题

- [假设] provider 白名单限制上游账户集；Gemini 与 Anthropic 是 Gateway 客户端协议。若用户原意是允许对应上游 provider/key，需要另行更新 REQ-03。
- 首个默认工具集合已确认并记入 proposal/design/tool guide：read/write/edit/bash/grep/glob、Ask、skill、search 与受保护的 tool_control；其余内置工具可切换但默认停用。
- [待验证] Gemini 首发范围以官方 REST Generate Content 与 streamGenerateContent 接口为起点，不覆盖 Interactions、Live API、embedding、media API，除非对应 Pi 模型 provider 和 feature 明确支持。
- [待验证] runtime event transport 的具体 Bun API 和 Windows 子进程启动/锁/恢复行为在 T-07 的可测试设计评审中锁定。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-27 | 初稿：定义层边界、初始 provider/auth 白名单、四种网关协议、工具变更和客户端/服务端分离 |

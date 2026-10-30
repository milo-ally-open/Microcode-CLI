# 提案：Microcode 运行时架构重构

> 状态：方案已起草；按任务分阶段实施<br>
> 路径：跨边界高风险<br>
> 负责人：Microcode maintainers<br>
> 上游合同：[现有模型与网关规范](../model_intergration_spec.md)、[系统能力规范](../system_capabilities_spec.md)、[Plugin 规范](../plugin_system_spec.md)、[工具呈现合同](../tool_agent_presentation_contract_spec.md)

## 背景与问题

项目已有独立的 MicrocodeAgent 门面、AgentToolManager、Pi 模型注册表和 Bun Model Gateway，但职责仍有跨层穿透。当前 CLI 在 src/main.tsx 创建 Agent 和 TUI；daemon 负责模型目录、认证及推理 RPC，并不持有 Agent loop、MCP、权限或会话。模型集合通过 builtinModels() 注册 Pi 的全部内置 provider，当前认证选择也按 Pi provider 的全部 auth 描述生成。工具注册表混合静态工具、动态 MCP 工具和 TUI 展示描述。

这会增加模型、工具、运行时和 UI 并行迭代时的协调成本，也使 CLI 客户端与 Agent 状态在同一进程内耦合。目标是确立稳定的内核适配边界、Microcode 运行时契约、模型与工具扩展注册点、能力加载边界，以及独立的 Bun 服务端和 Chalk TUI 客户端。

## 目标与成功观察

- Pi 的类型和实现被限制在内核适配及其 provider 适配模块；Microcode 领域接口可在以后替换 Pi。
- Agent、权限、会话、工具执行和能力生命周期由 Bun 后端服务持有；TUI 通过版本化 API 呈现状态并发送命令。
- 新模型和新工具可各自通过小型、可检查的扩展合同接入，不修改不相关运行时模块。
- 上游模型只开放 OpenAI Codex OAuth、OpenAI GPT API Key 和 DeepSeek API Key；网关单独兼容 OpenAI Chat Completions、OpenAI Responses、Gemini Generate Content 和 Anthropic Messages。
- Skills、MCP、Plugin 继续遵循现有来源、权限和生命周期合同。
- 单 Agent、CLI/TUI、会话持久化、权限控制及显式 no-daemon 路径可继续使用。

## 范围

### 本次包含

- 定义 Pi kernel adapter、Microcode runtime、model provider registry、tool registry、capability manager、Bun runtime server 与 TUI client 的责任和依赖方向。
- 规定初始上游供应商及认证白名单，并将模型供应商身份与客户端协议适配分开。
- 规定四种网关协议的最小兼容面和不支持请求的可见错误。
- 规定模型和工具 feature 的贡献流程、测试位置、权限边界和发布验收。
- 以独立进程服务化 Agent runtime，并让 TUI 经版本化传输连接。
- 用户通过 `/exit`、退出型 Ctrl+C 或终止信号结束 TUI 时，保存 session 并关闭该交互会话启动的后台进程，避免 Windows 安装程序被仍在运行的 CLI executable 锁住。
- 保留 Skills、MCP、Plugin、权限、session JSONL 与 Model Gateway 现有外部接入能力。

### 本次不包含 / 保持不变

- 不引入 GUI、Agent swarm、动态 JavaScript 插件执行、插件安装脚本或远程代码加载。
- 不更换 Bun、TypeScript、pi-ai 或 pi-agent-core；Pi 仍是当前 kernel 实现。
- 不把外部模型网关变成 Agent harness；外部协议请求只完成模型推理和协议转换，不执行工具。
- 不让 TUI 直接持有 provider credential、MCP process/client 或 session writer。
- Git/worktree 与一般任务管理保持为独立可选能力，不成为 Agent orchestration。

## 现状依据与约束

- src/main.tsx 的 main() 同时初始化模型传输、PluginManager、McpClientManager、SessionManager、MicrocodeAgent 和 App。
- src/daemon/runtime.ts 的 PiGatewayRuntime 实现 GatewayModelRuntime，提供模型发现、认证及 Pi stream/complete；src/daemon/server.ts 暴露公开模型协议和私有模型/auth RPC。
- src/models/registry.ts 用 builtinModels() 初始化共享集合，并在同一模块加载自定义 provider；src/models/authChoices.ts 从每个 provider 的 auth 描述生成登录选项。
- src/agent/MicrocodeAgent.ts 将 pi-agent-core Agent 包在 MicrocodeAgent API 后；src/agent/AgentToolManager.ts 已支持运行期间 addTools、removeTools、MCP 重配及模型感知的核心工具重建。
- src/tools/registry.ts 持有工具 Agent、policy 和 presentation 合同；src/plugins/PluginManager.ts 解析本地 Plugin 并以 Skills/MCP 贡献能力。
- package.json 与 bun.lock 将 @earendil-works/pi-ai 和 @earendil-works/pi-agent-core 固定为 0.87.1；本方案不以移动的上游 main 分支代替锁定版本。
- 仓库要求单 Agent、测试位于 tests/、保留现有 capability 规范和 Gateway 安全说明。

## 已确认决定与技术假设

- **用户决定：**内核当前采用 Pi，架构允许以后替换；运行时、模型、工具、能力和 TUI 分层；服务端使用 Bun，前端为终端 TUI。
- **用户决定：**初始模型认证只开放 OpenAI Codex OAuth、OpenAI GPT API Key、DeepSeek API Key；需要常见协议兼容和详细接入文档。
- **解释假设：**Gemini 与 Anthropic Messages 在第一阶段是外部客户端协议，不自动意味着允许 Gemini 或 Anthropic 上游账户凭据。上游供应商白名单与入口协议矩阵分别配置。
- **技术假设：**“插件式”模型/工具表示构建时注册、经评审的 TypeScript 扩展；安装目录里的 Plugin 仍仅组合 Skills/MCP，不执行任意代码。
- **技术假设：**后端服务仅在回环地址提供 Agent runtime API；可配置外部 bind 的 Model Gateway 与 runtime API 使用独立认证和监听边界。

## 备选方案与建议

| 方案 | 收益 | 成本/风险 |
|---|---|---|
| 只整理模块目录，继续由 TUI 进程持有 Agent | 变更小 | 前后端仍共享状态和生命周期，不满足服务边界 |
| 一次性重写全部模块与 API | 目标形态统一 | 回归面过大，session、权限、插件和 Gateway 风险集中 |
| 建立版本化扩展与传输合同，逐层迁移 | 每个 feature 可独立审查和回退；现有能力可分阶段迁移 | 需要短期维护旧入口与新入口的过渡 |

建议采用第三种方案。先冻结 contracts 与贡献指南，然后抽离 kernel/model facade、工具生命周期和 runtime service；TUI 最后切换到远程 client，保留明确的 no-daemon 运行路径。

## 影响面、依赖与风险

- 影响模型目录与登录、Agent 创建/消息/事件、工具审批与动态发现、session 生命周期、MCP、Plugin、CLI 参数、daemon 启停、Gateway 客户端及 TUI 状态投影。
- 服务端/客户端协议需处理版本协商、流重连、事件回放、权限 prompt 往返和命令幂等。
- TUI 自动启动的 Gateway 应标记为临时服务并在有序退出时停止；显式 `microcode gateway start` 启动的 Gateway 保持独立生命周期。
- 初始供应商限制会使当前其余 Pi provider 与自定义模型不再出现在模型目录；现有加密凭据不得因此被记录、打印或静默删除。
- session JSONL 与已有配置文件暂不迁移或覆盖；不支持的旧模型配置给出明确诊断，数据保留供用户恢复或手工迁移。
- 本地 runtime API 如暴露到外部会把权限、会话和工具控制面开放给远程调用方，因此必须只绑定回环地址并单独认证。
- 每个实施阶段可通过 revert 回滚；重构期间保持 session 格式和用户配置可读，避免不可逆数据迁移。

## 未决问题

| 问题 | 影响 | 负责人/验证方式 | 状态 |
|---|---|---|---|
| 第一版 Gemini 兼容要覆盖 REST Generate Content 的哪些 modality、函数调用和 SSE 细节 | 影响协议实现范围 | 以官方 API 文档及 fixture 验证，未覆盖项返回明确错误 | [待验证] |

## 变更记录

| 日期 | 内容 | 决定/依据 |
|---|---|---|
| 2026-10-27 | 初稿 | 用户给出的分层、初始 provider/auth 和前后端分离目标；当前代码核对 |
| 2026-10-27 | 首批默认工具收敛为 read/write/edit/bash/grep/glob、Ask、skill 与 tool search；Web/Vision/Task/worktree 保持可注册但不默认启用 | 按用户“保留最基础的工具”要求，将提案候选集落实；扩展工具通过 runtime tool registry 启用 |

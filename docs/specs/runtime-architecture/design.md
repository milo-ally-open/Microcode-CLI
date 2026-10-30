# 技术设计：Microcode 运行时架构重构

> 关联规格：[spec.md](spec.md)

## 当前实现与目标

当前 CLI 由 Bun Runtime 持有 Agent、session 和 capabilities；`src/models/piRuntime.ts` 持有 Pi model collection、auth、stream 和 complete，Model Gateway server 只依赖模型运行合同。目标是终端 TUI 作为独立 client；外部 Model Gateway 继续只提供模型推理兼容服务。

终端输入 / Chalk TUI
          │ Runtime Client：命令与事件 DTO
          ▼
本地 Bun Runtime API ── Microcode runtime ── Kernel adapter ── pi-agent-core / pi-ai
          │                    │
          │                    ├── Tool registry + PermissionManager
          │                    ├── Session / prompt / compaction
          │                    └── Skill / MCP / Plugin capability manager
          │
          └── 与外部 Model Gateway 分离的 loopback 管理 API

外部 harness ── OpenAI Chat / Responses / Gemini / Anthropic adapters
                       │ normalized model request
                       └── Model provider facade ── static provider registry ── pi-ai (current adapter)

## 方案

### 1. 依赖方向

- src/kernel/pi 实现 KernelAgent、KernelModel 和 Pi message/model/stream-event 转换；只在此层引入 pi-agent-core Agent loop API。`KernelAgentPort` 暴露只读 snapshot 与显式 set/prompt/lifecycle 操作，Pi adapter 独占 `Agent.state` 的可变访问，runtime 不直接改写内核状态。Pi lifecycle union 在 adapter 中映射为 `KernelAgentEvent`；Pi assistant stream event 的通用字段与 tool call 也在该边界投影。Agent 到 wire DTO 的事件/snapshot 投影位于 `src/agent/runtimeProjection.ts`，消息 mapper 由 Pi composition 显式传入；`src/runtime` 因此只拥有中性的 wire contracts/client/transport，不反向导入 Agent 或 Pi。Pi `beforeToolCall` context 在 adapter 内投影为 kernel-neutral `KernelToolCallRequest`，`afterToolCall` 通过 kernel contract 暴露工具名称与受控 `setTools` 操作，Pi state/context 同步留在 adapter；PermissionManager 不依赖 Pi callback 类型。投影组合 Agent 事件、状态和由 owner 预先生成的 capability DTO，kernel adapter 不依赖 Agent、MCP 或 instructions 实现。
- src/models/runtime.ts 定义 kernel-neutral ModelProviderRuntime 与 inference DTO；`src/models/piRuntime.ts` 提供当前 Pi-backed implementation，Pi model/message/event 转换集中在 `src/kernel/pi/modelAdapter.ts`，旧 `src/daemon/runtime.ts` 是兼容导出。四种 Gateway wire parser、serializer、SSE adapter 和私有 RPC 使用中性 DTO；Pi CLI client 在私有 RPC 两侧经 kernel adapter 转换。
- src/models/providers 定义 Microcode ModelProviderAdapter 并提供静态 Pi factory adapter。Pi Provider 留在模型层内部；TUI model catalog 与 auth DTO 使用 Microcode contracts。
- `src/agent/MicrocodeAgent.ts` 依赖泛型 `消息/模型泛型 AgentRuntimeAdapter`、kernel/runtime contracts、PermissionManager 和工具接口，不创建 Pi model collection；`src/agent/piRuntimeAdapter.ts` 作为 composition 组合当前 Pi kernel、model inference 与 compaction adapter。未来内核通过实现 AgentRuntimeAdapter 接入，不改 Agent 编排核心。
- `src/runtime/agentProjection.ts` 只接收已投影的 MCP summary DTO；敏感配置的摘要与脱敏由 daemon/runtime owner 在边界生成，projection 不导入 MCP discovery/config 实现。
- src/tools/contracts.ts 定义 kernel-neutral ToolAdapter、result 与 creation context；AgentToolManager、runtime port 和 registry 只持有该合同及窄 persistence capability。工具可选提供只读 `getApprovalPreview`，Agent 在 permission request DTO 中返回预览结果；TUI 仅负责渲染，不导入具体工具实现或在客户端读取受保护路径。`src/kernel/pi/agent.ts` 在初始化、更新和 snapshot 边界调用 `src/kernel/pi/toolAdapter.ts`，`MicrocodeAgent` 不再实例化 Pi AgentTool；工具集合管理不依赖 Pi。`src/tui/toolViews/` 保存 view，`src/tui/toolPresentationRegistry.ts` 单独管理按 tool ID 注册的 view 与进度文案；runtime 入口不导入 TUI 组件。
- src/skill、src/mcp、src/plugins 继续处理 capability discovery 和外部连接；变更由 runtime service 发送 versioned events。
- src/runtime/contracts.ts 定义 TUI 与 Bun service 共用的版本化 wire DTO，`src/runtime/transportClient.ts` 实现通用 HTTP/SSE transport，`src/runtime/client.ts` 提供重连和 snapshot session；`src/daemon/runtime-service` 负责 Bun server、command dispatch 与 sessions，避免 TUI 引用 daemon 实现。`src/daemon/runtime-service/types.ts` 与 `client.ts` 只保留兼容导出。`src/daemon/protocol/` 按 Chat Completions、Responses、Gemini Generate Content 与 Anthropic Messages 分离 request/response 和 SSE adapter，`protocol.ts` 与 `streaming.ts` 作为路由协调及稳定导出入口。外部协议 adapter 只调用 Model Gateway facade。
- src/tui/App 与 src/main.tsx 只处理终端交互、展示投影和显式 TUI ports；默认路径的 Agent、model、session、MCP、instructions 与 plugin 操作经 Runtime facades/commands，只有 `--no-daemon` 装配 Local adapters。文本 `@file` 引用由 `src/agent/MicrocodeAgent.ts` 调用共享 workspace reference helper 扫描、检查 read 权限并限量读取；TUI 只将原始输入发送给 Agent。TUI 仍在客户端列举文件用于补全，并读取用户明确附加的图片。工具时间线压缩工具行的结构性空白，保留预览内部换行；文本预览过滤终端控制字符，摘要按终端列宽截断。Runtime 连接状态通知只在状态切换时发出，TUI 用同一条提示行显示最近状态，SSE 重连在流建立时确认恢复。

### 2. Model facade 与协议矩阵

初始内置 provider registry 只静态注册：

| Microcode provider ID | 实现 | 支持认证 | 初始上游 API |
|---|---|---|---|
| openai-codex | 锁定版本的 Pi OpenAI Codex provider | OAuth | OpenAI Codex Responses |
| openai | 锁定版本的 Pi OpenAI provider | API Key | OpenAI Responses 与该版本声明的 GPT 模型 |
| deepseek | 锁定版本的 Pi DeepSeek provider | API Key | OpenAI Chat Completions-compatible |

登录选项由 Microcode policy 与 Pi provider capability 的交集生成。凭据仍由 EncryptedCredentialStore/Pi CredentialStore 管理。

客户端协议独立映射：

| Dialect | Route family | Contract |
|---|---|---|
| OpenAI Chat Completions | /v1/chat/completions | JSON 或 SSE chat completion 与 function tool calls |
| OpenAI Responses | /v1/responses | response/output item lifecycle 与 function calls |
| Gemini Generate Content | /v1beta/models/{model}:generateContent 和 :streamGenerateContent | GenerateContent request/response；流式为 SSE/chunks |
| Anthropic Messages | /v1/messages | messages request/response 与 content-block SSE events |

模型 ID 使用 provider/model。Gemini/Anthropic 客户端请求可指定 allowlist 中的 OpenAI 或 DeepSeek upstream model；客户端 key、协议头或 OAuth 信息不能被当作 upstream credential。功能交集外的 modality、thinking、tool_choice、sampling 和 structured output 必须拒绝或明确记录为未实现。

### 3. Tool registry 与动态集合

工具执行注册表只保留 Agent adapter 与 policy，增加稳定 registry ID、版本和 runtime mutability。TUI presentation 使用独立 registry 按 tool ID 关联 view、状态投影与审批预览，不由 runtime 加载。可切换实现须在服务启动时静态注册。Skill/MCP 保持自己的 capability 生命周期。

ActiveToolSet 是会话范围、单调递增版本的 immutable snapshot。启停操作在 turn boundary 校验候选集合后原子替换；在途 tool call 保持其启动时的实现。工具审批始终通过 PermissionManager。审计事件只记录 tool ID、action、session ID、registry version 和许可结果，不记录 secret 参数。

首批默认启用 `read`、`write`、`edit`、`bash`、`grep`、`glob`、`Ask`、`skill`、`search` 和受保护的 `tool_control`。Web、Vision、Task 与 worktree 仍编译时注册，但初始停用；MCP tool 在连接并发现后加入本会话 registry。

Agent-facing `tool_control` 仅接受已知 ID 与 enable/disable。不得 eval、动态 import 任意代码或改写 permission rules。若激活工具扩大当前 permission policy 未覆盖的能力，按既有 ask/deny/allow 规则处理，不隐式授予。保护 `tool_control`，避免 Agent 无法恢复。

### 4. 服务/API 与事件生命周期

本地 runtime transport 使用独立版本化 namespace 和认证 token。建议命令使用 HTTP JSON POST，状态和增量使用 Server-Sent Events；具体 Bun primitive 在 T-07 锁定。权限/问题 prompt 由服务端事件发送，TUI 回答作为新的 command 发送。

T-07 transport slice 当前固定为 `GET /runtime/v1/health`、受认证 `GET /runtime/v1/handshake`、`GET /runtime/v1/snapshot?session_id=…`、`POST /runtime/v1/commands`、`GET /runtime/v1/events?session_id=…` 与受认证 `POST /runtime/v1/shutdown`。命令要求 `protocol_version`、session-scoped `request_id`、`session_id` 和 `{type,payload}`；SSE 使用单调序号及 `Last-Event-ID`，snapshot 携带最新 event sequence，replay window 过期时返回 `snapshot_required`。listener 仅允许绑定 `127.0.0.1`/`::1`，并使用独立 Bearer token。

Runtime daemon 的配置放在 `~/.microcode/runtime/{per-workspace-session-key}/`，其中 token 使用随机值并仅当前用户可读，metadata 原子更新且只记录 loopback host、动态分配端口、PID、工作目录和 session ID。workspace 与可选 resume session ID 生成隔离 key；CLI 生命周期 helper 通过锁避免重复启动。child 在初始化时先写入 `starting` metadata，再在 listener 就绪后写入 `ready`；父进程超时后仍能等待原 child，避免重复启动。daemon 收到认证 shutdown command 后持久化并停止。runtime child runner 负责加载项目指令、Plugin Skill/MCP 与 standalone MCP，并只向 runtime DTO 暴露经过筛选的 capability 摘要；MCP 连接在服务握手后异步建立。`src/runtime/client.ts` 的 client 支持 snapshot sequence、SSE 断线重连与过期快照恢复；常规 CLI 路径现在通过 launcher/client 连接 runtime，`--no-daemon` 保留明确的进程内 Agent 路径。

命令 DTO 包含 protocol_version、request_id、session_id 和 command type。服务端对同一 request_id 作有限期去重，避免重连造成重复 prompt 或 shell 操作。事件 DTO 包含 protocol_version、session_id、sequence、type 和 payload。重连传 last_sequence；事件窗口过期时返回 snapshot_required 并让 TUI 获取完整快照。

后端创建 SessionManager、PluginManager、McpClientManager、PermissionManager、Agent runtime 和 model/tool registry。权限答复校验 pending request ID、session 所有权与有效期。关机先拒绝新 command，再 abort 活动请求、持久化 session、断开 MCP 并停止监听。

本地 runtime API 使用 127.0.0.1 独立端口和随机令牌。可配置 host/port 的外部 Model Gateway 使用不同 token、路由与权限边界。

### 5. 启动、回退和数据

TUI launcher 启动或复用兼容 runtime daemon，握手通过后创建 client。失败展示原因。no-daemon 明确走 in-process kernel/runtime adapter。session JSONL 继续由唯一 SessionManager 写入；daemon 重启后读取既有文件。临时 transport 断连只重连，不停止 runtime；用户有序退出时先中止活动 turn、关闭 client，再通过认证 shutdown 停止 runtime，并等待 listener 关闭和记录 PID 退出。TUI 自动启动的 Model Gateway 在 metadata 中标为临时服务并随 TUI 有序退出停止；`microcode gateway start` 标记为持久服务，退出 TUI 时保留。两个 daemon 的 stop helper 都等待实际子进程退出，不能只依据 HTTP listener 已关闭判断完成。

旧 model config 中不支持的 provider 不注册、不自动请求、不删除；诊断指向模型接入指南。旧加密凭据保留但不可从当前 registry 使用。按用户要求直接在 `main` 上暂存改造，不创建新分支或提交；如需回退可撤销本次改造 diff，保留已有未暂存的 `src/macro.ts` 修改。避免不可逆 session/config 变更。

## 接口和数据

建议的 Microcode contracts：

- KernelAgent：prompt、steer、follow-up、abort、waitForIdle、subscribe、read-only snapshot、messages、model/thinking 与 tool 更新；公共输入使用 `RuntimeImageInput`/`RuntimeThinkingLevel`，Pi image/thinking 类型仅在 kernel adapter 内转换。
- ModelProviderAdapter：稳定 provider ID、认证模式、metadata、model catalog、auth lifecycle、stream/cancel 与错误归一化。
- GatewayDialectAdapter：parseRequest、serializeUnary、serializeStream、validateCapabilities；不得执行模型返回的 function tool。
- ToolDefinition：稳定的 `name` 同时作为 registry ID 与 kernel tool name、正整数 `version`、Agent schema/description/execute、policy metadata、runtime mutability。TUI presentation 在 `src/tui/toolPresentationRegistry.ts` 独立注册。
- RuntimeTransport：handshake、snapshot、command、event stream、acknowledge prompt、close。
- TuiAgentPort、TuiModelPort、TuiSessionPort、TuiMcpPort、TuiInstructionsPort、TuiGitPort 和 TuiPluginPort：Chalk UI 所需的窄 client contracts；Runtime facade 与 `--no-daemon` local adapter 分别实现，不把本地 manager 或 Pi implementation 类型塞进 App。插件快照仅含展示所需元数据与 MCP server 摘要；skills、插件目录和原始 server config 保留在后端 capability owner 中。

这些是 Microcode contracts，不复制 Pi API 类型。Adapter 内转换 pi-ai 和 pi-agent-core；跨进程 DTO 只含 JSON 可序列化内容。

## 安全、运维与兼容

- Runtime API 与 external Gateway 使用独立 host、token、版本和路由。Runtime API 只绑定 loopback；wildcard 配置不得改变其 bind。
- Gateway 继续遵循 AGENTS.md 的安全说明；没有 TLS、per-client identity、quotas、tenant isolation 时，不宣称 public bind 适合生产。
- 所有 stream 和 pending prompt 支持取消；错误、日志和 TUI diagnostics redaction credentials、OAuth callback data 与 MCP secrets。
- 协议版本不兼容时拒绝 mutation command 并给出升级提示，不降级权限检查。
- 不支持的 provider/protocol option 使用稳定错误 code、field path 与修复提示，不静默改变 safety/privacy/tool 语义。
- 分阶段并行维护旧/new entrypoint；每步先实现 adapter、验收，再移除旧入口。session/config 格式保持不变。

## 备选方案和取舍

| 方案 | 优点 | 放弃原因/代价 |
|---|---|---|
| SSE 事件流加 HTTP 命令 | 易重放和调试，适配 Bun Request/Response | 双向对话用多个 endpoint；以 prompt ID 与 request ID 管理 |
| 单 WebSocket command/event 通道 | 双向单连接，实时性直接 | 断线状态与重试更复杂 |
| TUI 继续直接调用 Agent | 保留当前实现较容易 | 不满足前后端分离 |

第一阶段选 SSE + HTTP commands，并将 DTO 与 transport interface 隔离，为以后替换 WebSocket 留口。

## 未决项

- Gemini capability matrix 实现前依官方 REST docs 与锁定 Pi API 审核。
- Bun runtime listener 和 Windows lifecycle 需由 T-07 contract prototype 记录。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-27 | 初稿：定义边界、provider/dialect 矩阵、runtime transport、工具 snapshot 与回退 |
| 2026-10-27 | 首批基础工具集及静态注册扩展工具的 runtime 启停路径落入 T-05；服务端 command/event 投影仍由 T-07 实施 |
| 2026-10-27 | 将内置工具 View、进度文案、输入投影与审批预览从 `src/tools` runtime registry 移到 `src/tui/toolPresentationRegistry.ts`；工具实现入口不再静态导入 `UI.tsx` |
| 2026-10-30 | `/exit`、退出型 Ctrl+C 与 SIGTERM 统一清理 Runtime 和临时 Gateway；停止流程等待 daemon PID 退出，Gateway 显式 `start` 保持持久生命周期 |

# 新工具接入与运行时变更指南

本文规定工具如何作为独立 GitHub feature 接入，以及 Agent 如何改变本会话的工具集合。安装目录 Plugin 的 Skill/MCP 语义由 [Plugin 规范](../plugin_system_spec.md)决定；安装的 Plugin 不执行 JavaScript。

## 工具模块边界

- 单项工具使用不可复用的 `ToolDefinition.name` 作为稳定 registry ID 与 Agent tool name；`version` 是正整数的工具合同版本，源码放在 src/tools/ 的独立模块目录。
- `src/tools/contracts.ts` 的 `ToolAdapter` 定义 schema、描述、执行入口、取消信号、流式更新与结构化结果，不依赖 Pi；`src/tools/registry.ts` 只保留 adapter factory、发现元数据与默认权限。AgentToolManager 始终保存中性 `ToolAdapter`；`MicrocodeAgent` 在将工具集合交给内核时，通过 `src/kernel/pi/toolAdapter.ts` 转换为锁定版本的 Pi `AgentTool`。新增内核时只需实现对应 adapter，不改工具 registry。TUI view 放在 `src/tui/toolViews/`；activity/detail/status 文案、流式输入投影和审批预览由静态 TUI feature module 调用 `registerToolPresentation` 登记在 `src/tui/toolPresentationRegistry.ts`，按稳定 tool ID 关联。
- Agent 输出和 TUI 预览分离；工具结果 details 不自动进入模型上下文。
- `src/agent` 和 runtime service 只加载工具执行注册表，不导入 `UI.tsx` 或 `pi-tui`。为工具增加界面时，只改 TUI presentation registry，不在工具执行入口注册 terminal component。
- MCP tool 由 MCP capability adapter 构造；不能绕过 PermissionManager。
- Web、Vision、Task、Git/worktree 等按独立模块注册；默认集合由 runtime config 选择。任务管理与 Git/worktree 不构成 Agent orchestration。

## 单个工具 feature 流程

1. 为一个工具建立 GitHub feature branch；先定义输入、输出、错误、资源限制、默认权限和会话内切换策略。
2. 在 src/tools/ 新增模块，沿用共享 TypeBox schema 和 tool registry contract；业务实现不依赖 TUI 布局，也不导入 UI component。
3. 有外部副作用时明确 allow、ask 或 deny 默认值；所有执行统一经 PermissionManager。permission config 不在 ToolDefinition 中执行。
4. 仅将稳定 ID、描述和 schema 投影给模型；参数大小、文件范围、进程超时和结果截断须有边界。
5. 有用户展示需求时，在 `src/tui/toolPresentationRegistry.ts` 为该 tool ID 注册 view 和语义状态/预览投影；不返回 ANSI、Chalk 字符串或排版后的 terminal component 给 runtime。
6. 如支持运行时启停，设置 `mutable: true`（默认）或显式设为 `false`；注册时可声明 `version`（默认 `1`）。运行时只接受 registry 中已编译实现的 ID，禁止动态 import/eval。
7. 在 tests/tools/ 与相关 tests/agent/ 覆盖 schema、正常/error/cancel、权限 ask/deny、结果边界、启停和运行中的旧 snapshot。
8. 更新 default tool-set 配置、用户文档与 registry guide，说明 Windows/Bun 环境和权限影响。

## Agent runtime 修改工具集合

- 当前 Agent 通过 `tool_control` 暴露 list/enable/disable；runtime API 使用 registry tool ID、enable/disable action 和同一 snapshot 版本合同。
- `MicrocodeAgent.setToolEnabled` 也必须提交从当前工具 snapshot 读取的 `expectedVersion`；省略版本不属于合法 runtime mutation。
- 服务端验证工具存在、当前 capability scope 可用、工具允许动态变更及调用方 session 所有权。
- Runtime `tool.set` command 必须带 snapshot 中的正整数 `expected_version`；服务端先要求 Agent idle，再在 idle wait 后紧邻变更前复核版本。旧版本返回 `409 stale_tool_snapshot`，客户端需读取新 snapshot 后重试。
- 同进程的 `MicrocodeAgent.addTools/removeTools/configureMcpTools` 只允许在 Agent idle 时调用；若 Agent 正在生成或执行 tool call，会在触碰 registry 前失败。MCP 生命周期 owner 在活动 turn 期间延后应用 refresh。
- 对候选集合完整验证后，原子替换 ActiveToolSet snapshot 并递增版本；校验失败不产生部分注册。
- 后续模型 turn 使用新 snapshot；执行中的 tool call 不改变其已绑定实现。
- 每次执行仍调用 PermissionManager。加入工具不等于允许执行；模式或 deny rule 仍有最终裁决权。
- 工具变更事件只含 tool ID、操作、snapshot version 与结果；client 不能提交代码或 permission override。
- 核心安全管理工具和正在执行的 tool-control handler 可设为受保护 ID，避免 Agent 无法恢复。

## 首批最小集合选择

首批默认启用 `read`、`write`、`edit`、`bash`、`grep`、`glob`、`Ask`、`skill` 和 `search`；`tool_control` 始终启用且受保护。Web search/fetch、vision、Task 与 Git/worktree 仍注册在运行时工具目录中，默认停用，可由 Agent 启用。MCP tool 只在服务器连接并加入当前 Agent capability scope 后可发现和切换。

## 接入审查清单

- 工具 ID 全局唯一；不覆盖内置、Plugin 或 MCP ID。
- 参数校验发生在执行前；失败返回不含 secret 的可操作诊断。
- 权限检查覆盖 Agent、MCP、runtime command 与 UI action。
- 命令执行、网络和文件操作有取消、超时和输出上限。
- Agent content 与 presentation details 有清晰边界。
- 动态添加不改变 permission grants、不在运行时执行任意代码。
- tests 全部位于 repository root 的 tests/ 下，并只覆盖该工具及受影响 contract。

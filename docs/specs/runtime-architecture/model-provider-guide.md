# 新模型 Provider 接入指南

本指南给单个 GitHub feature 使用。目标是让新模型只增加一个经过 review 的静态 adapter；provider 行为、auth、模型元数据和协议能力由 Microcode facade 管理。本文补充 [运行时架构规格](spec.md)，不能放宽 provider 白名单或直接调用网络 API。

当前 allowlist 与锁定 catalog 能力见 [provider capability matrix](provider-capability-matrix.md)；Gateway 的四种客户端协议另见 [protocol capability matrix](protocol-capability-matrix.md)。

## 接入前先分类

1. **上游 provider 与认证：**首批只有 openai-codex OAuth、openai API Key 和 deepseek API Key。
2. **上游 Pi API 与客户端 Gateway 协议：**上游 api 值来自锁定 pi-ai Model；客户端 dialect 是独立入口，两者名称相同不代表可互换。

Gemini Generate Content 和 Anthropic Messages 首批表示 Gateway 入口 dialect。它们不自动开放 Google 或 Anthropic 上游 key/provider。只有产品决策更新 REQ-03 后才能加入。

## 每个 feature 的实施步骤

1. 从当前 main 建立独立 GitHub feature branch；限定提交只实现一个 provider feature。
2. 阅读 AGENTS.md、本文、[model integration spec](../model_intergration_spec.md) 和 package.json/bun.lock，记录 pi-ai 与 pi-agent-core 锁定版本。
3. 阅读 live pi-ai README 和目标 provider source 作为发现资料；核对 node_modules 中精确 0.87.1 声明和实现。版本不匹配时不照搬 moving main 代码。
4. 确认锁定版本是否提供所需 provider factory。当前存在 openaiProvider、deepseekProvider、openaiCodexProvider；从 provider-specific import path 导入并复用 Pi factory。当前 OpenAI registration 仅公开 `gpt-*`，并排除 Realtime catalog entries。
5. 在 src/models/providers/ 下为该贡献新增独立 adapter 文件，通过受控 registry 注册 provider ID、显示名、正整数 adapter version、auth modes、模型/API 能力和 Pi factory；registry aggregator 只需增加一项引用。模块不缓存 provider secret，不重复实现 HTTP API。
6. Registry 校验 ID 唯一、provider 在 build allowlist 内、auth mode 允许、model api 可映射到已注册 client capability。目录列出 provider/model、输入、contextWindow、maxTokens、reasoning 能力和 locked catalog source。
7. Provider adapter 只声明 Pi factory；认证状态和流程统一经 `src/models/authFacade.ts`。Codex 使用 Pi OAuth lifecycle；OpenAI/DeepSeek API Key 走 Pi CredentialStore / EncryptedCredentialStore 和支持的环境变量。禁止复制浏览器 cookies、其他 CLI token 或私有 client ID。
8. 在 tests/models/ 下覆盖注册与选择、auth choice、metadata、缺少凭据、错误/取消、secret redaction 和禁用 provider 拒绝。普通测试不连接 vendor OAuth 或推理 endpoint。
9. 若 provider 需要锁定 Pi 版本未提供的 API，先单独提案升级依赖。升级后核对 lockfile API、Bun standalone 包和 CLI 启动；不改 dependency source，不运行时下载 provider catalog。
10. 更新 provider matrix、架构 REQ 与 contract fixture。PR 说明 provider scope、auth path、Pi version、已运行测试/build、未覆盖能力及手动 smoke 结果。

## Provider adapter 合同

| 字段/操作 | 责任 |
|---|---|
| id、name、version | 稳定且唯一的 provider 身份、显示名与正整数 adapter contract revision |
| authModes、supportedApis | Microcode policy 声明；注册时必须与 Pi factory 实际认证能力和 model API 一致 |
| createPiProvider | 仅由 adapter 内调用锁定 Pi provider factory，不返回给 runtime 或 TUI |
| client catalog projection | `getModelCatalog()` 返回 Pi-free 的只读 provider/model 描述，不含 endpoint、凭据或 Pi 实例 |
| runtime catalog command | `model.catalog` 将上述描述通过 Bun Runtime transport 暴露给 TUI；菜单不直接读取 Pi `Models` 或 Gateway client |
| listModels | 返回当前 registry 允许使用的模型元数据 |
| authStatus、login、logout | 经服务端 credential store 的认证生命周期；TUI 使用 `model.auth.*` Runtime 命令，auth prompts 和 notifications 通过 Runtime event 返回 |
| stream、complete | 规范化请求/事件，支持取消 |
| diagnostics | 说明配置问题，剔除 credential 和 auth payload |

Pi implementation 留在 adapter 内部。Microcode API 不返回 Pi Provider、MutableModels、AuthResult、OAuth credential 或 ApiStreamOptions。

当前 Gateway 内部通过 `src/models/runtime.ts` 的 `ModelProviderRuntime` 访问目录、认证、stream 和 complete。合同使用 `ModelRuntimeDescriptor`、`ModelInferenceContext`、`ModelCompletion` 与 `ModelStreamEvent`，不导入 Pi；`src/models/piRuntime.ts` 是当前实现，Pi model/message/event 转换集中于 `src/kernel/pi/modelAdapter.ts`。四种 Gateway wire parser、serializer、SSE adapter 和私有 RPC 都使用中性模型 DTO；Pi CLI client 在调用私有 RPC 前后经 kernel adapter 转换。后续 provider feature 应只改 provider registry adapter，不要让 TUI 或 Gateway HTTP route 直接导入 Pi `Models`。

### Runtime/TUI 模型合同

- `model.catalog` 返回 provider/model 元数据；TUI 选择器只依赖 `ModelCatalogSnapshot`。
- `model.auth.providers`、`model.auth.status`、`model.auth.logout` 承载无秘密 provider 描述、认证状态与登出。
- `model.auth.login` 快速返回确认；后台 OAuth/API Key 交互通过 `model_auth_prompt` 和 `model_auth_notification` 事件发送。TUI 将用户输入用 `model.auth.prompt.resolve` 回传，取消用 `model.auth.cancel`，完成由 `model_auth_complete` 通知。
- `session.title.suggest` 是当前 Agent 模型调用的 runtime-owned 辅助能力；它不属于 provider adapter，也不要求 TUI 取得 Pi Model 或 Gateway completion client。
- `--no-daemon` 的本地 adapter 实现相同 `TuiAgentPort` 方法；模型/auth DTO 不因执行模式不同而改变。

## 模型元数据和请求验证

- 唯一模型标识使用 provider/model。裸 model ID 只在唯一匹配时解析。
- Gateway 验证 provider 与模型均在运行时 allowlist；未知或禁用模型返回明确错误，不猜测 fallback。
- Client protocol adapter 将 text/image/tool calls/sampling/reasoning/options 映射到 Pi 能力；不支持的输入或参数在上游请求前拒绝，或记录于协议 fixture。
- 工具调用由外部 harness 执行；Gateway 只序列化 tool call，不导入 Microcode 工具注册表。
- usage、reasoning、stop reason 缺失时标记 unavailable；不得编造。

## Review 清单

- provider 是否在批准的 allowlist，provider ID 和 auth mode 是否精确？
- 是否只使用锁定 Pi public API，优先复用 Pi 功能？
- model list、login choices、errors、logs 和 TUI events 是否不泄露密钥？
- modality、tools、streaming、cancellation 与 unsupported options 是否有 fixture？
- 测试是否位于 tests/ 且不访问真实模型服务？
- README、AGENTS.md、model spec 和依赖版本是否一致？
- bundled build 是否仍打包所需 OAuth loader，且 no-daemon 仍可用？

## 参考资料

- 锁定依赖：package.json、bun.lock 和 node_modules/@earendil-works/pi-ai/package.json。
- Pi discovery README：[pi-ai README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)，用于发现，不作为本项目运行时真相。
- Google：[Gemini Generate Content](https://ai.google.dev/api/generate-content)。
- OpenAI：[Chat Completions](https://platform.openai.com/docs/api-reference/chat)、[Responses streaming](https://platform.openai.com/docs/guides/streaming-responses)。
- Anthropic：[Messages API](https://docs.anthropic.com/en/api/messages)。

## 本次核对记录

2026-10-28：package.json 与 bun.lock 固定 pi-ai/pi-agent-core 0.87.1；安装的 pi-ai 声明导出 createModels/createProvider 及 openai/deepseek/openai-codex factories，认证和 API 实现由 Pi provider 管理。`tests/fixtures/models/provider-capabilities.expected.json` 与 provider fixture tests 现覆盖三项 allowlisted provider/API/auth 组合、代表模型 modality/reasoning/context/output metadata、API-key/OAuth facade 生命周期、usage，以及 image/reasoning 不支持时在 inference 前拒绝。DeepSeek stream fixture 使用锁定 Pi adapter 和本地 SSE 服务；Codex/OpenAI 未发送实时上游请求。具体验收记录见 `docs/specs/runtime-architecture/tasks.md`。

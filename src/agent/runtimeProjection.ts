import type { MicrocodeAgentEvent, MicrocodeAgentSnapshot } from './types.ts'
import type { KernelAssistantMessageEvent } from '../kernel/contracts.ts'
import type {
  RuntimeAgentEvent,
  RuntimeAgentSnapshot,
  RuntimeMessage,
  RuntimeTokenSnapshot,
  RuntimeTokenUsage,
} from '../runtime/contracts.ts'

interface TokenUsageValue {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  totalCost: number
}

function mapTokenUsage(usage: TokenUsageValue): RuntimeTokenUsage {
  return Object.freeze({
    requests: usage.requests ?? 0,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_tokens: usage.cacheReadTokens ?? 0,
    cache_write_tokens: usage.cacheWriteTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
    total_cost: usage.totalCost ?? 0,
  })
}

function mapTokenSnapshot(snapshot: MicrocodeAgentSnapshot['tokens']): RuntimeTokenSnapshot {
  const mapByModel = (value: MicrocodeAgentSnapshot['tokens']['currentModel']) => Object.freeze({
    key: value.key,
    model_id: value.modelId,
    provider_id: value.provider,
    api_id: value.api,
    ...mapTokenUsage(value),
  })
  return Object.freeze({
    context: Object.freeze({
      system_prompt_tokens: snapshot.context.systemPromptTokens,
      message_tokens: snapshot.context.messageTokens,
      used_tokens: snapshot.context.usedTokens,
      remaining_tokens: snapshot.context.remainingTokens,
      context_window: snapshot.context.contextWindow,
      percent_used: snapshot.context.percentUsed,
      percent_remaining: snapshot.context.percentRemaining,
    }),
    session: mapTokenUsage(snapshot.session),
    current_model: mapByModel(snapshot.currentModel),
    by_model: Object.freeze(Object.fromEntries(Object.entries(snapshot.byModel).map(([key, usage]) => [key, mapByModel(usage)]))),
  })
}

function mapPermissionRule(rule: { toolName: string; ruleContent?: string; behavior: string; source: string }) {
  return Object.freeze({
    tool_id: rule.toolName,
    ...(rule.ruleContent === undefined ? {} : { rule_content: rule.ruleContent }),
    behavior: rule.behavior,
    source: rule.source,
  })
}

export function toRuntimeAgentSnapshot(
  snapshot: MicrocodeAgentSnapshot,
  messages: readonly RuntimeMessage[],
  capabilities: {
    mcpServers?: readonly Readonly<{
      name: string
      status: string
      toolCount: number
      resourceCount: number
      summary: string
    }>[]
    plugins?: readonly {
      name: string
      version: string
      description: string
      health: string
      valid?: boolean
      enabled: boolean
      scope: string
      skills?: readonly unknown[]
      diagnostics?: readonly string[]
      servers?: readonly { name: string; qualifiedName: string; transport: string; safeCommandSummary: string; sourcePath: string }[]
    }[]
    capabilityDiagnostics?: readonly string[]
    projectInstructions?: Readonly<{
      projectRoot: string
      workingDirectory: string
      files: readonly Readonly<{ path: string; content: string; bytes: number; truncated: boolean }>[]
      diagnostics: readonly string[]
      totalBytes: number
    }>
    session?: { id: string; cwd: string; createdAt: string | number; title?: string }
  } = {},
): RuntimeAgentSnapshot {
  const mapRules = (rules: readonly { toolName: string; ruleContent?: string; behavior: string; source: string }[]) =>
    Object.freeze(rules.map(mapPermissionRule))
  const modelConfig = snapshot.modelConfig
  return Object.freeze({
    identity: Object.freeze({ ...snapshot.identity }),
    cwd: snapshot.cwd,
    model: snapshot.model,
    messages: Object.freeze([...messages]),
    model_config: Object.freeze({
      provider_id: modelConfig.provider,
      api_key_configured: modelConfig.apiKeyConfigured,
      thinking_level: modelConfig.thinkingLevel,
    }),
    thinking_level: snapshot.thinkingLevel,
    message_count: snapshot.messageCount,
    tool_names: Object.freeze([...snapshot.toolNames]),
    tools: Object.freeze({
      version: snapshot.tools.version,
      active: Object.freeze([...snapshot.tools.active]),
      names: Object.freeze([...snapshot.tools.names]),
      registered: Object.freeze([...snapshot.tools.registered]),
      mutable: Object.freeze([...snapshot.tools.mutable]),
      disabled: Object.freeze([...snapshot.tools.disabled]),
      unloaded: Object.freeze([...snapshot.tools.unloaded]),
      registry: Object.freeze(snapshot.tools.registry.map((item) => Object.freeze({ ...item }))),
      core: Object.freeze([...snapshot.tools.core]),
      infrastructure: Object.freeze([...snapshot.tools.infrastructure]),
      discovered: Object.freeze([...snapshot.tools.discovered]),
      external: Object.freeze([...snapshot.tools.external]),
    }),
    skills: Object.freeze({
      available: Object.freeze(snapshot.skills.available.map((skill) => Object.freeze({
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        disable_model_invocation: skill.disableModelInvocation,
        file_path: skill.filePath,
        base_dir: skill.baseDir,
        ...(skill.pluginId ? { plugin_id: skill.pluginId } : {}),
      }))),
      diagnostics: Object.freeze([...snapshot.skills.diagnostics]),
      loaded: Object.freeze(snapshot.skills.loaded.map((skill) => Object.freeze({ name: skill.name }))),
    }),
    capabilities: Object.freeze({
      diagnostics: Object.freeze([...(capabilities.capabilityDiagnostics ?? [])]),
      mcp_servers: Object.freeze((capabilities.mcpServers ?? []).map((server) => Object.freeze({
        name: server.name,
        status: server.status,
        tool_count: server.toolCount,
        resource_count: server.resourceCount,
        summary: server.summary,
      }))),
      plugins: Object.freeze((capabilities.plugins ?? []).map((plugin) => Object.freeze({
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        health: plugin.health,
        valid: plugin.valid ?? (plugin.health !== 'invalid' && plugin.health !== 'incompatible'),
        enabled: plugin.enabled,
        scope: plugin.scope,
        skill_count: plugin.skills?.length ?? 0,
        diagnostics: Object.freeze([...(plugin.diagnostics ?? [])]),
        servers: Object.freeze((plugin.servers ?? []).map((server) => Object.freeze({
          name: server.name,
          qualified_name: server.qualifiedName,
          transport: server.transport,
          safe_command_summary: server.safeCommandSummary,
          source_path: server.sourcePath,
        }))),
      }))),
    }),
    project_instructions: Object.freeze({
      project_root: capabilities.projectInstructions?.projectRoot ?? snapshot.cwd,
      working_directory: capabilities.projectInstructions?.workingDirectory ?? snapshot.cwd,
      files: Object.freeze((capabilities.projectInstructions?.files ?? []).map((file) => Object.freeze({
        path: file.path,
        content: file.content,
        bytes: file.bytes,
        truncated: file.truncated,
      }))),
      diagnostics: Object.freeze([...(capabilities.projectInstructions?.diagnostics ?? [])]),
      total_bytes: capabilities.projectInstructions?.totalBytes ?? 0,
    }),
    session: Object.freeze({
      id: capabilities.session?.id ?? snapshot.identity.id.replace(/^assistant-/, ''),
      cwd: capabilities.session?.cwd ?? snapshot.cwd,
      created_at: capabilities.session?.createdAt ?? Date.now(),
      ...(capabilities.session?.title ? { title: capabilities.session.title } : {}),
    }),
    is_streaming: snapshot.isStreaming,
    pending_tool_call_count: snapshot.pendingToolCallCount,
    permission: Object.freeze({
      mode: snapshot.permission.mode,
      approval_mode: snapshot.permission.approvalMode,
      allow_rules: mapRules(snapshot.permission.allowRules),
      deny_rules: mapRules(snapshot.permission.denyRules),
      ask_rules: mapRules(snapshot.permission.askRules),
    }),
    effective_policy: Object.freeze({
      approval_mode: snapshot.effectivePolicy.approvalMode,
      rules: mapRules(snapshot.effectivePolicy.rules),
    }),
    tokens: mapTokenSnapshot(snapshot.tokens),
    ...(snapshot.errorMessage ? { error_message: snapshot.errorMessage } : {}),
  })
}

function jsonValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? undefined : JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

export function toRuntimeAgentEvent<Message>(
  event: MicrocodeAgentEvent<Message>,
  mapMessage: (message: Message) => RuntimeMessage,
): RuntimeAgentEvent {
  const payload: Record<string, unknown> = { agent_id: event.agentId }

  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
      return { type: event.type, payload }
    case 'agent_end':
      payload.messages = event.messages.map(mapMessage)
      return { type: event.type, payload }
    case 'turn_end':
      payload.message = mapMessage(event.message)
      payload.tool_results = event.toolResults.map(mapMessage)
      return { type: event.type, payload }
    case 'message_start':
    case 'message_end':
      payload.message = mapMessage(event.message)
      return { type: event.type, payload }
    case 'message_update':
      payload.message = mapMessage(event.message)
      payload.assistant_event = toRuntimeAssistantMessageEvent(event.assistantMessageEvent, mapMessage)
      return { type: event.type, payload }
    case 'tool_execution_start':
      payload.tool_call_id = event.toolCallId
      payload.tool_id = event.toolName
      payload.arguments = jsonValue(event.args) ?? {}
      return { type: event.type, payload }
    case 'tool_execution_update':
      payload.tool_call_id = event.toolCallId
      payload.tool_id = event.toolName
      payload.arguments = jsonValue(event.args) ?? {}
      payload.partial_result = jsonValue(event.partialResult)
      return { type: event.type, payload }
    case 'tool_execution_end':
      payload.tool_call_id = event.toolCallId
      payload.tool_id = event.toolName
      payload.result = jsonValue(event.result)
      payload.is_error = event.isError
      return { type: event.type, payload }
    case 'state_changed':
      payload.reason = event.reason
      payload.snapshot = toRuntimeAgentSnapshot(event.snapshot, [])
      return { type: event.type, payload }
    case 'token_usage':
      payload.usage = mapTokenSnapshot(event.usage)
      return { type: event.type, payload }
    case 'permission_requested':
    case 'permission_resolved':
      payload.request = {
        request_id: event.request.requestId,
        kind: event.request.kind,
        tool_id: event.request.toolName,
        input: jsonValue(event.request.input) ?? {},
        ...(event.request.description ? { description: event.request.description } : {}),
        ...(event.request.preview ? { preview: jsonValue(event.request.preview) } : {}),
      }
      if (event.type === 'permission_resolved') payload.allowed = event.allowed
      return { type: event.type, payload }
    case 'model_changed':
      payload.previous = event.previous
      payload.current = event.current
      return { type: event.type, payload }
    case 'tool_started':
      payload.tool_call_id = event.toolCallId
      payload.tool_id = event.toolName
      return { type: event.type, payload }
    case 'tool_finished':
      payload.tool_call_id = event.toolCallId
      payload.tool_id = event.toolName
      payload.is_error = event.isError
      return { type: event.type, payload }
    case 'compaction_changed':
      payload.progress = jsonValue(event.progress)
      return { type: event.type, payload }
    default: {
      const unreachable: never = event
      return unreachable
    }
  }
}

function toRuntimeAssistantMessageEvent<Message>(
  event: KernelAssistantMessageEvent<Message>,
  mapMessage: (message: Message) => RuntimeMessage,
): Record<string, unknown> {
  const output: Record<string, unknown> = { type: event.type }
  if (event.contentIndex !== undefined) output.content_index = event.contentIndex
  if (event.delta !== undefined) output.delta = event.delta
  if (event.content !== undefined) output.content = event.content
  if (event.partial !== undefined) output.partial = mapMessage(event.partial)
  if (event.message !== undefined) output.message = mapMessage(event.message)
  if (event.error !== undefined) output.error = mapMessage(event.error)
  if (event.toolCall) {
    output.tool_call = {
      type: 'tool_call',
      call_id: event.toolCall.id,
      tool_id: event.toolCall.name,
      arguments: event.toolCall.arguments,
      ...(event.toolCall.namespace ? { namespace: event.toolCall.namespace } : {}),
    }
  }
  if (event.reason !== undefined) output.reason = event.reason
  return output
}

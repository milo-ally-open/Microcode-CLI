/** Stable runtime-facing reasoning effort values shared by the daemon and TUI. */
export const RUNTIME_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type RuntimeThinkingLevel = typeof RUNTIME_THINKING_LEVELS[number]

export function isRuntimeThinkingLevel(value: unknown): value is RuntimeThinkingLevel {
  return typeof value === 'string' && (RUNTIME_THINKING_LEVELS as readonly string[]).includes(value)
}

export interface RuntimeImageInput {
  readonly data: string
  readonly mimeType: string
}

export type RuntimeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | { type: 'image'; data: string; mime_type: string }
  | { type: 'tool_call'; call_id: string; tool_id: string; arguments: Record<string, unknown>; namespace?: string }

export type RuntimeMessage =
  | { role: 'system'; content: string | Array<{ type: 'text'; text: string }>; sections?: Record<string, string | null>; timestamp: number }
  | { role: 'user'; content: string | RuntimeContentBlock[]; timestamp: number }
  | {
      role: 'assistant'
      content: RuntimeContentBlock[]
      model: { provider_id: string; model_id: string; api_id: string }
      usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost: number }
      stop_reason: string
      error_message?: string
      timestamp: number
    }
  | {
      role: 'tool_result'
      call_id: string
      tool_id: string
      content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mime_type: string }>
      details?: unknown
      is_error: boolean
      timestamp: number
    }
  | {
      role: 'command_activity'
      command: string
      output: string
      exit_code: number | null
      cancelled: boolean
      truncated: boolean
      full_output_path?: string
      timestamp: number
    }
  | {
      role: 'custom'
      kind: string
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mime_type: string }>
      display: boolean
      details?: unknown
      timestamp: number
    }
  | {
      role: 'summary'
      kind: 'branch' | 'compaction'
      summary: string
      timestamp: number
      from_id?: string | null
      tokens_before?: number
    }

export interface RuntimeModelDescriptor {
  id: string
  provider_id: string
  model_id: string
  api_id: string
  name: string
  input: readonly string[]
  context_window: number
  max_output_tokens: number
  reasoning: boolean
}

export interface RuntimeTokenUsage {
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  total_cost: number
}

export interface RuntimeTokenSnapshot {
  context: Readonly<{
    system_prompt_tokens: number
    message_tokens: number
    used_tokens: number
    remaining_tokens: number
    context_window: number
    percent_used: number
    percent_remaining: number
  }>
  session: Readonly<RuntimeTokenUsage>
  current_model: Readonly<RuntimeTokenUsage & { key: string; model_id: string; provider_id: string; api_id: string }>
  by_model: Readonly<Record<string, Readonly<RuntimeTokenUsage & { key: string; model_id: string; provider_id: string; api_id: string }>>>
}

export interface RuntimeToolRegistrySnapshot {
  version: number
  active: readonly string[]
  names: readonly string[]
  registered: readonly string[]
  mutable: readonly string[]
  disabled: readonly string[]
  unloaded: readonly string[]
  registry: readonly Readonly<{ id: string; version: number; mutable: boolean }>[]
  core: readonly string[]
  infrastructure: readonly string[]
  discovered: readonly string[]
  external: readonly string[]
}

export interface RuntimeAgentSnapshot {
  identity: Readonly<{ id: string; name?: string; role?: string }>
  cwd: string
  model: RuntimeModelDescriptor
  messages: readonly RuntimeMessage[]
  model_config: Readonly<{ provider_id: string; api_key_configured: boolean; thinking_level: RuntimeThinkingLevel }>
  thinking_level: RuntimeThinkingLevel
  message_count: number
  tool_names: readonly string[]
  tools: RuntimeToolRegistrySnapshot
  skills: Readonly<{
    available: readonly Readonly<{
      name: string
      description: string
      scope: string
      disable_model_invocation: boolean
      file_path: string
      base_dir: string
      plugin_id?: string
    }>[]
    diagnostics: readonly string[]
    loaded: readonly Readonly<{ name: string }>[]
  }>
  capabilities: Readonly<{
    diagnostics: readonly string[]
    mcp_servers: readonly Readonly<{
      name: string
      status: string
      tool_count: number
      resource_count: number
      summary: string
    }>[]
    plugins: readonly Readonly<{
      name: string
      version: string
      description: string
      health: string
      valid: boolean
      enabled: boolean
      scope: string
      skill_count: number
      diagnostics: readonly string[]
      servers: readonly Readonly<{
        name: string
        qualified_name: string
        transport: string
        safe_command_summary: string
        source_path: string
      }>[]
    }>[]
  }>
  project_instructions: Readonly<{
    project_root: string
    working_directory: string
    files: readonly Readonly<{ path: string; content: string; bytes: number; truncated: boolean }>[]
    diagnostics: readonly string[]
    total_bytes: number
  }>
  session: Readonly<{ id: string; cwd: string; created_at: string | number; title?: string }>
  is_streaming: boolean
  pending_tool_call_count: number
  permission: Readonly<{
    mode: string
    approval_mode: string
    allow_rules: readonly Readonly<{ tool_id: string; rule_content?: string; behavior: string; source: string }>[]
    deny_rules: readonly Readonly<{ tool_id: string; rule_content?: string; behavior: string; source: string }>[]
    ask_rules: readonly Readonly<{ tool_id: string; rule_content?: string; behavior: string; source: string }>[]
  }>
  effective_policy: Readonly<{
    approval_mode: string
    rules: readonly Readonly<{ tool_id: string; rule_content?: string; behavior: string; source: string }>[]
  }>
  tokens: RuntimeTokenSnapshot
  error_message?: string
}

export interface RuntimeAgentEvent {
  type: string
  payload: Record<string, unknown>
}

/** Runtime client/server wire contract shared by the TUI transport and Bun service. */
export const RUNTIME_SERVICE_PROTOCOL_VERSION = 1

export type RuntimeCommandType =
  | 'prompt'
  | 'prompt.read_only'
  | 'abort'
  | 'model.catalog'
  | 'model.select'
  | 'model.auth.providers'
  | 'model.auth.status'
  | 'model.auth.login'
  | 'model.auth.prompt.resolve'
  | 'model.auth.cancel'
  | 'model.auth.logout'
  | 'session.title.suggest'
  | 'thinking.set'
  | 'permission.set'
  | 'permission.check'
  | 'permission.request'
  | 'permission.rule.add'
  | 'permission.resolve'
  | 'question.resolve'
  | 'tool.set'
  | 'session.clear'
  | 'session.list'
  | 'session.open'
  | 'session.title.set'
  | 'session.tasks.list'
  | 'session.tasks.remind'
  | 'session.export'
  | 'session.compact'
  | 'skill.set'
  | 'plugin.refresh'
  | 'plugin.set'
  | 'plugin.set_many'
  | 'mcp.refresh'
  | 'git.status'
  | 'git.branches'
  | 'git.diff'
  | 'git.history'
  | 'git.stage'
  | 'git.unstage'
  | 'git.discard'
  | 'git.commit'
  | 'git.branch.switch'
  | 'git.branch.create'
  | 'git.branch.delete'
  | 'git.fetch'
  | 'git.pull'
  | 'git.push'
  | 'git.stash.push'
  | 'git.stash.list'
  | 'git.stash.apply'
  | 'instructions.init.propose'
  | 'instructions.init.apply'
  | 'instructions.reload'

export interface RuntimeCommandEnvelope {
  protocol_version: number
  request_id: string
  session_id: string
  command: {
    type: RuntimeCommandType
    payload: Record<string, unknown>
  }
}

export interface RuntimeCommandAck {
  protocol_version: number
  request_id: string
  session_id: string
  accepted: true
  result?: unknown
}

export interface RuntimeEventEnvelope {
  protocol_version: number
  session_id: string
  sequence: number
  type: string
  payload: Record<string, unknown>
}

export interface RuntimeSnapshotEnvelope {
  protocol_version: number
  session_id: string
  sequence: number
  snapshot: unknown
}

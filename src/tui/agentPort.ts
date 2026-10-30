import type { TuiProjectInstructions } from './instructionsPort.ts'
import type { PermissionDecision, PermissionMode } from '../permissions/types.ts'
import type { RuntimeAgentEvent, RuntimeAgentSnapshot, RuntimeMessage, RuntimeModelDescriptor } from '../runtime/contracts.ts'
import type { RuntimeImageInput, RuntimeThinkingLevel } from '../runtime/contracts.ts'

export type TuiTokenUsage = Readonly<{
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  totalCost: number
}>

export type TuiModelTokenUsage = TuiTokenUsage & Readonly<{
  key: string
  modelId: string
  provider: string
  api: string
}>

export interface TuiTokenSnapshot {
  readonly context: Readonly<{
    systemPromptTokens: number
    messageTokens: number
    usedTokens: number
    remainingTokens: number
    contextWindow: number
    percentUsed: number
    percentRemaining: number
  }>
  readonly session: TuiTokenUsage
  readonly currentModel: TuiModelTokenUsage
  readonly byModel: Readonly<Record<string, TuiModelTokenUsage>>
}

export interface TuiSkillDescriptor {
  readonly name: string
  readonly description: string
  readonly scope: string
  readonly filePath: string
  readonly baseDir: string
  readonly disableModelInvocation: boolean
  readonly pluginId?: string
}

export interface TuiSkillSnapshot {
  readonly available: readonly TuiSkillDescriptor[]
  readonly diagnostics: readonly string[]
  readonly loaded: readonly Readonly<{ name: string }>[]
}

/** Small view-facing snapshot; the UI currently needs only the working directory. */
export interface TuiAgentSnapshot {
  readonly cwd: string
  readonly model: RuntimeModelDescriptor
  readonly thinkingLevel: TuiThinkingLevel
  readonly tokens: Pick<TuiTokenSnapshot, 'context' | 'session'>
}

export type TuiThinkingLevel = RuntimeThinkingLevel

export type TuiImageInput = RuntimeImageInput

/** Permission prompts are an interactive UI concern, so their handlers belong to the TUI port. */
export type TuiPermissionRequestHandler = (
  toolName: string,
  input: Record<string, unknown>,
  description: string,
  requestId: string,
  preview?: Record<string, unknown>,
) => Promise<boolean>

export type TuiAskUserQuestionHandler = (
  toolName: string,
  input: Record<string, unknown>,
  requestId: string,
) => Promise<{ answers?: Record<string, string>; block?: boolean }>

/** Result data needed by the view; transcript messages remain runtime-owned. */
export interface TuiCompactionResult {
  readonly summary: string
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly keptMessageCount: number
  readonly automatic: boolean
}

export type TuiAgentEvent =
  | { readonly type: 'agent_start' | 'agent_end' | 'turn_start' }
  | { readonly type: 'capabilities_changed' }
  | { readonly type: 'state_changed'; readonly reason: string }
  | { readonly type: 'compaction_changed'; readonly progress: { readonly phase: string } }
  | { readonly type: 'message_start' | 'message_end'; readonly message: RuntimeMessage }
  | { readonly type: 'message_update'; readonly message: RuntimeMessage; readonly assistantMessageEvent: { readonly type: string; readonly delta?: string } }
  | { readonly type: 'tool_execution_start'; readonly toolCallId: string; readonly toolName: string; readonly args: Record<string, unknown> }
  | { readonly type: 'tool_execution_update'; readonly toolCallId: string; readonly toolName: string; readonly args: Record<string, unknown>; readonly partialResult: Record<string, unknown> }
  | { readonly type: 'tool_execution_end'; readonly toolCallId: string; readonly toolName: string; readonly result: Record<string, unknown>; readonly isError: boolean }
  | { readonly type: 'turn_end'; readonly message: RuntimeMessage }

export type TuiAgentEventListener = (event: TuiAgentEvent, signal: AbortSignal) => Promise<void> | void

/** Project runtime wire events into the small vocabulary consumed by the Chalk view. */
export function toTuiAgentEvent(event: RuntimeAgentEvent): TuiAgentEvent | undefined {
  const payload = event.payload
  const message = (value: unknown): RuntimeMessage | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { role?: unknown }).role === 'string'
      ? value as RuntimeMessage
      : undefined
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  switch (event.type) {
    case 'agent_start': case 'agent_end': case 'turn_start':
      return { type: event.type }
    case 'capabilities_changed':
      return { type: event.type }
    case 'state_changed':
      return { type: event.type, reason: String(payload.reason ?? '') }
    case 'compaction_changed':
      return { type: event.type, progress: record(payload.progress) as { phase: string } }
    case 'message_start': case 'message_end': {
      const value = message(payload.message)
      return value ? { type: event.type, message: value } : undefined
    }
    case 'message_update': {
      const value = message(payload.message)
      if (!value) return undefined
      const assistantEvent = record(payload.assistant_event)
      return {
        type: event.type,
        message: value,
        assistantMessageEvent: {
          type: String(assistantEvent.type ?? ''),
          ...(typeof assistantEvent.delta === 'string' ? { delta: assistantEvent.delta } : {}),
        },
      }
    }
    case 'tool_execution_start':
      return { type: event.type, toolCallId: String(payload.tool_call_id ?? ''), toolName: String(payload.tool_id ?? ''), args: record(payload.arguments) }
    case 'tool_execution_update':
      return { type: event.type, toolCallId: String(payload.tool_call_id ?? ''), toolName: String(payload.tool_id ?? ''), args: record(payload.arguments), partialResult: record(payload.partial_result) }
    case 'tool_execution_end':
      return { type: event.type, toolCallId: String(payload.tool_call_id ?? ''), toolName: String(payload.tool_id ?? ''), result: record(payload.result), isError: payload.is_error === true }
    case 'turn_end': {
      const value = message(payload.message)
      return value ? { type: event.type, message: value } : undefined
    }
    default:
      return undefined
  }
}

/** Minimal view-facing Agent API; local and remote runtimes implement the same surface. */
export interface TuiAgentPort {
  getRuntimeCapabilities?(): RuntimeAgentSnapshot['capabilities'] | undefined
  subscribeRuntimeConnection?(listener: (connected: boolean, error?: Error) => void): () => void
  getSnapshot(): TuiAgentSnapshot
  getMessages(): readonly RuntimeMessage[]
  getCurrentModel(): RuntimeModelDescriptor
  isBusy(): boolean
  prompt(input: string, images?: readonly TuiImageInput[]): Promise<void>
  promptReadOnly(input: string): Promise<void>
  abort(): void
  subscribe(listener: TuiAgentEventListener): () => void
  getTokenStats(): Readonly<TuiTokenSnapshot>
  compact(options?: { instructions?: string; persistToSession?: boolean }): Promise<Readonly<TuiCompactionResult>>
  persistMessages(): Promise<void>
  clearMessages(): void | Promise<void>
  setThinkingLevel(level: TuiThinkingLevel): void | Promise<void>
  getPermissionMode(): PermissionMode
  setPermissionMode(mode: PermissionMode): void | Promise<void>
  checkPermission(toolName: string, input: Record<string, unknown>): PermissionDecision | Promise<PermissionDecision>
  requestToolPermission(toolName: string, input: Record<string, unknown>, description: string): Promise<boolean>
  addSessionPermission(toolName: string, ruleContent?: string): void | Promise<void>
  setPermissionRequestHandler(handler: TuiPermissionRequestHandler): void
  setAskUserQuestionHandler(handler: TuiAskUserQuestionHandler): void
  getSkillSnapshot(): Readonly<TuiSkillSnapshot>
  getSkills(): readonly TuiSkillDescriptor[]
  isSkillLoaded(skillName: string): boolean
  loadSkill(skillName: string): void | Promise<void>
  unloadSkill(skillName: string): void | Promise<void>
  refreshSystemPrompt(): void | Promise<void>
  getProjectInstructions(): TuiProjectInstructions | undefined
}

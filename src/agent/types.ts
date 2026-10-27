import type { AgentModelConfig } from './AgentModelManager.ts'
import type { RuntimeModelSource } from '../runtime/modelProjection.ts'
import type { McpServerState } from '../mcp/types.ts'
import type {
  EffectivePolicy,
  PermissionDecision,
  PermissionMode,
  PermissionSnapshot,
} from '../permissions/index.ts'
import type { CompactionProgress, CompactionSettings, CompactionSummaryGenerator } from '../session/CompactionManager.ts'
import type { AgentTokenSnapshot } from './AgentTokenTracker.ts'
import type { AgentModelSnapshot } from './AgentModelManager.ts'
import type { AgentToolSnapshot } from './AgentToolManager.ts'
import type { AgentSkillSnapshot } from './AgentSkillManager.ts'
import type { AgentSessionPersistence } from './persistence.ts'
import type { ProjectInstructions } from '../instructions/projectInstructions.ts'
import type { Skill } from '../skill.ts'
import type { RuntimeModelDescriptor, RuntimeThinkingLevel } from '../runtime/contracts.ts'
import type { KernelAgentEvent } from '../kernel/contracts.ts'

export interface AgentIdentity {
  id: string
  name?: string
  role?: string
}

export type CreateAgentIdentity = Partial<AgentIdentity> & Pick<AgentIdentity, 'id'>

export interface AgentPermissionConfig {
  mode?: PermissionMode
  allow?: string[]
  deny?: string[]
  ask?: string[]
  onPermissionRequest?: (
    toolName: string,
    input: Record<string, unknown>,
    description: string,
    requestId: string,
    preview?: Record<string, unknown>,
  ) => Promise<boolean>
  onAskUserQuestion?: (
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
  ) => Promise<{ answers?: Record<string, string>; block?: boolean }>
}

export interface CreateMicrocodeAgentOptions<
  Message = unknown,
  Model extends RuntimeModelSource = RuntimeModelSource,
> {
  cwd?: string
  projectInstructions?: ProjectInstructions
  modelId?: string
  /** Protocol format (e.g., "anthropic-messages", "openai-completions"). Must match the model ID. */
  api?: string
  thinkingLevel?: RuntimeThinkingLevel
  mcpServers?: McpServerState[]
  onCompactionProgress?: (progress: CompactionProgress) => void
  permission?: AgentPermissionConfig
  skillPaths?: string[]
  pluginSkills?: Skill[]
  pluginDiagnostics?: string[]
  /** Backend-owned plugin mention expansion, invoked with the original user text. */
  pluginPromptContext?: (input: string, scanText: string) => string
  identity?: CreateAgentIdentity
  persistence?: AgentSessionPersistence<Message>
  summarize?: CompactionSummaryGenerator<Message>
  compactionSettings?: Partial<CompactionSettings>
  /** Optional transport-owned initial selection and resolver for the active model runtime. */
  initialModelConfig?: AgentModelConfig<Model>
  resolveModelConfig?: (modelId: string, api?: string, provider?: string) => AgentModelConfig<Model>
  resolveModelApiKey?: (model: Model) => string | undefined
}

export interface CompactAgentOptions {
  instructions?: string
  persistToSession?: boolean
}

export interface AgentCompactionResult<Message = unknown> {
  readonly summary: string
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly keptMessageCount: number
  readonly messages: readonly Message[]
  readonly automatic: boolean
}

export interface MicrocodeAgentSnapshot {
  readonly identity: Readonly<AgentIdentity>
  readonly cwd: string
  readonly model: RuntimeModelDescriptor
  readonly modelConfig: Readonly<AgentModelSnapshot>
  readonly thinkingLevel: RuntimeThinkingLevel
  readonly systemPrompt: string
  readonly messageCount: number
  readonly toolNames: readonly string[]
  readonly tools: Readonly<AgentToolSnapshot>
  readonly skills: Readonly<AgentSkillSnapshot>
  readonly isStreaming: boolean
  readonly pendingToolCallCount: number
  readonly permission: Readonly<PermissionSnapshot>
  readonly effectivePolicy: Readonly<EffectivePolicy>
  readonly tokens: Readonly<AgentTokenSnapshot>
  readonly errorMessage?: string
}

type WithAgentId<T> = T extends unknown
  ? T & { readonly agentId: string }
  : never

export type MicrocodeAgentCoreEvent<Message = unknown> = WithAgentId<KernelAgentEvent<Message>>

export interface AgentPermissionRequest {
  readonly requestId: string
  readonly kind: 'tool' | 'question'
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly description?: string
  readonly preview?: Readonly<Record<string, unknown>>
}

export type AgentStateChangeReason =
  | 'core_event'
  | 'messages_replaced'
  | 'messages_cleared'
  | 'thinking_changed'
  | 'model_changed'
  | 'permission_changed'
  | 'system_prompt_changed'
  | 'tools_changed'
  | 'skills_changed'
  | 'compaction_completed'

export type MicrocodeAgentEvent<Message = unknown> =
  | MicrocodeAgentCoreEvent<Message>
  | {
      readonly type: 'state_changed'
      readonly agentId: string
      readonly reason: AgentStateChangeReason
      readonly snapshot: Readonly<MicrocodeAgentSnapshot>
    }
  | {
      readonly type: 'token_usage'
      readonly agentId: string
      readonly usage: Readonly<AgentTokenSnapshot>
    }
  | {
      readonly type: 'permission_requested'
      readonly agentId: string
      readonly request: Readonly<AgentPermissionRequest>
    }
  | {
      readonly type: 'permission_resolved'
      readonly agentId: string
      readonly request: Readonly<AgentPermissionRequest>
      readonly allowed: boolean
    }
  | {
      readonly type: 'model_changed'
      readonly agentId: string
      readonly previous: RuntimeModelDescriptor
      readonly current: RuntimeModelDescriptor
    }
  | {
      readonly type: 'tool_started'
      readonly agentId: string
      readonly toolCallId: string
      readonly toolName: string
    }
  | {
      readonly type: 'tool_finished'
      readonly agentId: string
      readonly toolCallId: string
      readonly toolName: string
      readonly isError: boolean
    }
  | {
      readonly type: 'compaction_changed'
      readonly agentId: string
      readonly progress: Readonly<CompactionProgress>
    }

export type MicrocodeAgentEventListener<Message = unknown> = (
  event: MicrocodeAgentEvent<Message>,
  signal: AbortSignal,
) => Promise<void> | void

export type MessageUsageResetMode = 'rebuild' | 'preserve'

export type AgentPermissionDecision = PermissionDecision

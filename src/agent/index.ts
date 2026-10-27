import { MicrocodeAgent } from './MicrocodeAgent.ts'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { createPiAgentRuntimeAdapter, type PiMicrocodeAgentOptions } from './piRuntimeAdapter.ts'

export function createMicrocodeAgentRuntime(
  options: PiMicrocodeAgentOptions = {},
): MicrocodeAgent<AgentMessage, Model<Api>> {
  return new MicrocodeAgent(createPiAgentRuntimeAdapter(options), options)
}

export type PiMicrocodeAgent = MicrocodeAgent<AgentMessage, Model<Api>>

export { MicrocodeAgent } from './MicrocodeAgent.ts'
export type { AgentRuntimeAdapter, AgentKernelSetup } from './contracts.ts'
export { AgentToolSnapshotConflictError } from './AgentToolManager.ts'
export { createPiModelMessageMapper as createConvertToLlm } from '../kernel/pi/mapper.ts'
export type {
  AgentIdentity,
  AgentCompactionResult,
  AgentPermissionConfig,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentStateChangeReason,
  CompactAgentOptions,
  CreateAgentIdentity,
  CreateMicrocodeAgentOptions,
  MessageUsageResetMode,
  MicrocodeAgentCoreEvent,
  MicrocodeAgentEvent,
  MicrocodeAgentEventListener,
  MicrocodeAgentSnapshot,
} from './types.ts'
export type {
  AgentTokenSnapshot,
  ApiTokenUsage,
  ContextTokenUsage,
  ModelTokenUsage,
} from './AgentTokenTracker.ts'
export type { AgentModelSnapshot } from './AgentModelManager.ts'
export type { AgentToolSnapshot } from './AgentToolManager.ts'
export type {
  AgentSkillSnapshot,
  LoadedSkillSnapshot,
} from './AgentSkillManager.ts'
export type {
  AgentCompactionRecord,
  AgentSessionPersistence,
} from './persistence.ts'

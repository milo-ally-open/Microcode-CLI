import type { AgentModelConfig } from './AgentModelManager.ts'
import type { CompactionMessageAdapter, CompactionSummaryGenerator } from '../session/contracts.ts'
import type { RuntimeImageInput, RuntimeModelDescriptor, RuntimeThinkingLevel } from '../runtime/contracts.ts'
import type {
  KernelAfterToolCall,
  KernelAgentEvent,
  KernelAgentPort,
  KernelBeforeToolCall,
} from '../kernel/contracts.ts'
import type { ToolAdapter } from '../tools/contracts.ts'
import type { RuntimeModelSource } from '../runtime/modelProjection.ts'
import type { TokenEstimatorMessage } from '../session/TokenEstimator.ts'

export interface AgentKernelSetup<Message, Model extends RuntimeModelSource> {
  readonly systemPrompt: string
  readonly model: Model
  readonly getCurrentModel: () => Model
  readonly tools: readonly ToolAdapter<any, any>[]
  readonly prepareRequest: (messages: readonly Message[]) => Promise<Message[]>
}

/** Runtime-facing model/kernel integration. Pi and future kernels implement this port. */
export interface AgentRuntimeAdapter<Message, Model extends RuntimeModelSource> {
  getDefaultModelConfig(): AgentModelConfig<Model>
  resolveModelConfig(modelId: string, api?: string, provider?: string): AgentModelConfig<Model>
  resolveApiKey(model: Model): string | undefined
  supportsImages(model: Model): boolean
  describeModel(model: Model): RuntimeModelDescriptor
  modelPromptIdentity(model: Model): string
  createKernel(
    setup: AgentKernelSetup<Message, Model>,
    hooks: {
      beforeToolCall: KernelBeforeToolCall
      afterToolCall: KernelAfterToolCall<ToolAdapter<any, any>>
    },
  ): KernelAgentPort<
    Message,
    Model,
    ToolAdapter<any, any>,
    KernelAgentEvent<Message>,
    RuntimeThinkingLevel,
    RuntimeImageInput
  >
  getCompactionMessageAdapter(): CompactionMessageAdapter<Message>
  createCompactionSummarizer(getModel: () => Model): CompactionSummaryGenerator<Message>
  generateTitle(model: Model, openingSentence: string): Promise<string>
  isTaskReminderMessage(message: Message): boolean
  createTaskReminderMessage(reminder: string): Message
  toTokenEstimatorMessage(message: Message): TokenEstimatorMessage
  applySystemPrompt(messages: readonly Message[], prompt: string): Message[]
}

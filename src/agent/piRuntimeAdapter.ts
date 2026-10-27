import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { getModelConfig, getModels, type ModelConfig } from '../models/index.ts'
import { resolveAgentModelApiKey, resolveAgentModelConfig } from '../models/agentResolver.ts'
import type { AgentRuntimeAdapter, AgentKernelSetup } from './contracts.ts'
import type { CreateMicrocodeAgentOptions } from './types.ts'
import type { ToolAdapter } from '../tools/contracts.ts'
import type { TokenEstimatorMessage } from '../session/TokenEstimator.ts'
import { toRuntimeModel } from '../kernel/pi/mapper.ts'
import { createPiKernelAgent } from '../kernel/pi/agent.ts'
import {
  createPiCompactionSummarizer,
  piCompactionMessageAdapter,
} from '../kernel/pi/compaction.ts'
import { createPiModelMessageMapper } from '../kernel/pi/mapper.ts'

export type PiMicrocodeAgentOptions = CreateMicrocodeAgentOptions<AgentMessage, Model<Api>> & {
  /** In-process Pi collection; daemon callers may inject their authenticated proxy. */
  models?: Models
  /** Test/transport stream override used by the Pi adapter only. */
  streamFn?: StreamFn
}

/** Composes Pi kernel, Pi model inference, and Pi transcript behavior for MicrocodeAgent. */
export function createPiAgentRuntimeAdapter(
  options: PiMicrocodeAgentOptions,
): AgentRuntimeAdapter<AgentMessage, Model<Api>> {
  const models = options.models ?? getModels()
  const resolveModelConfig = options.resolveModelConfig
    ?? ((modelId: string, api?: string, provider?: string): ModelConfig =>
      resolveAgentModelConfig(modelId, api, provider))

  return {
    getDefaultModelConfig: () => getModelConfig(),
    resolveModelConfig,
    resolveApiKey: options.resolveModelApiKey ?? resolveAgentModelApiKey,
    supportsImages: (model) => model.input.includes('image'),
    describeModel: toRuntimeModel,
    modelPromptIdentity: (model) => `${model.provider}/${model.id}`,
    createKernel(setup, hooks) {
      const piSetup = setup as AgentKernelSetup<AgentMessage, Model<Api>>
      return createPiKernelAgent({
        initialState: {
          systemPrompt: setup.systemPrompt,
          model: setup.model,
          tools: setup.tools,
        },
        streamFn: options.streamFn ?? ((model, context, streamOptions) =>
          models.streamSimple(model, context, streamOptions)),
        convertToLlm: createPiModelMessageMapper(setup.getCurrentModel),
        // Pi prepareRequest replaces the running context before provider inference.
        prepareRequest: async ({ context }) => ({
          context: {
            ...context,
            messages: await piSetup.prepareRequest(context.messages),
          },
        }),
      }, hooks)
    },
    getCompactionMessageAdapter: () => piCompactionMessageAdapter,
    createCompactionSummarizer: (getModel) => createPiCompactionSummarizer({ models, getModel }),
    async generateTitle(model, openingSentence) {
      const result = await models.completeSimple(model, {
        systemPrompt: 'Generate a short, concise title (5 words max) for a conversation. Reply with ONLY the title, no quotes, no explanation.',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `Generate a title for a conversation that starts with: "${openingSentence.slice(0, 200)}"` }],
          timestamp: Date.now(),
        }],
      }, { maxTokens: 30, temperature: 0.3 })
      return result.content.find((content) => content.type === 'text')?.text?.trim().replace(/^['"]|['"]$/g, '') ?? ''
    },
    isTaskReminderMessage(message) {
      return message.role === 'custom' && message.customType === 'task-reminder'
    },
    createTaskReminderMessage(reminder) {
      return {
        role: 'custom',
        customType: 'task-reminder',
        content: reminder,
        display: false,
        timestamp: Date.now(),
      }
    },
    toTokenEstimatorMessage(message) {
      return message as TokenEstimatorMessage
    },
    applySystemPrompt(messages, prompt) {
      const next = [...messages]
      const systemIndex = next.findIndex((message) => message.role === 'system')
      const systemMessage = { role: 'system' as const, content: prompt, timestamp: Date.now() }
      if (systemIndex >= 0) next[systemIndex] = systemMessage
      else next.unshift(systemMessage)
      return next
    },
  }
}

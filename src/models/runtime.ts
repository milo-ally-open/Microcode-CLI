import type { ModelAuthInteraction, ModelAuthProviderDescriptor, ModelAuthType } from './contracts.ts'
import type { ModelCompletion, ModelInferenceContext, ModelRuntimeDescriptor, ModelStreamEvent } from './inference.ts'
export type { ModelCompletion, ModelInferenceContext, ModelRuntimeDescriptor, ModelStreamEvent } from './inference.ts'

/**
 * Runtime operations the model layer provides to the Model Gateway.
 * The contract is kernel-neutral; the Pi implementation maps to this DTO at
 * the explicit adapter boundary under src/kernel/pi/.
 */
export interface ModelRuntimeOptions {
  maxTokens?: number
  temperature?: number
  reasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  reasoningSummary?: 'auto' | 'concise' | 'detailed'
  toolChoice?: 'auto' | 'none'
  parallelToolCalls?: boolean
  samplingParams?: Record<string, unknown>
}

export type ModelProviderDescriptor = ModelAuthProviderDescriptor
export type { ModelAuthInteraction }

/** Internal provider facade consumed by the external gateway server. */
export interface ModelProviderRuntime {
  getModels(projectCwd?: string): readonly ModelRuntimeDescriptor[]
  getCurrentModel?(projectCwd?: string): ModelRuntimeDescriptor | undefined
  getProviders(projectCwd?: string): readonly ModelProviderDescriptor[]
  checkAuth(providerId: string, projectCwd: string | undefined, signal: AbortSignal): Promise<{ type: ModelAuthType } | undefined>
  login(providerId: string, type: ModelAuthType, interaction: ModelAuthInteraction, projectCwd?: string): Promise<void>
  logout(providerId: string, projectCwd: string | undefined, signal: AbortSignal): Promise<void>
  resolveModel(modelId: string, projectCwd?: string): ModelRuntimeDescriptor | undefined | Promise<ModelRuntimeDescriptor | undefined>
  stream(model: ModelRuntimeDescriptor, context: ModelInferenceContext, options: ModelRuntimeOptions & { signal?: AbortSignal }): AsyncIterable<ModelStreamEvent>
  complete(model: ModelRuntimeDescriptor, context: ModelInferenceContext, options: ModelRuntimeOptions & { signal?: AbortSignal }): Promise<ModelCompletion>
}

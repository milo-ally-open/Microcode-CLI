import type { ModelAuthInteraction, ModelProviderDescriptor, ModelProviderRuntime, ModelRuntimeOptions } from '../models/runtime.ts'
import type { ModelInferenceContext, ModelRuntimeDescriptor } from '../models/inference.ts'

export type GatewayRequestOptions = ModelRuntimeOptions
export type GatewayProviderDescriptor = ModelProviderDescriptor
export type GatewayAuthInteraction = ModelAuthInteraction
export type GatewayModelRuntime = ModelProviderRuntime

export type GatewayDialect = 'internal' | 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-generate'

export interface GatewayChatRequest {
  modelId: string
  context: ModelInferenceContext
  options: GatewayRequestOptions
  stream: boolean
  anthropicThinkingDisplay?: 'summarized' | 'omitted'
  responsesToolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>
}

export interface GatewayModelDescriptor extends ModelRuntimeDescriptor {}

export interface GatewayModelIdentity {
  readonly id: string
  readonly provider: string
}

export interface GatewayServerOptions {
  token: string
  rpcToken: string
  runtime: GatewayModelRuntime
  hostname?: string
  port?: number
  maxRequestBytes?: number
  maxInternalRequestBytes?: number
  maxConcurrentRequests?: number
  maxStreamIdleMs?: number
}

export interface GatewayServerHandle {
  hostname: string
  port: number
  stop(): Promise<void> | void
}

export function describeModel(model: ModelRuntimeDescriptor): GatewayModelDescriptor {
  return {
    id: `${model.provider}/${model.id}`,
    name: model.name,
    provider: model.provider,
    api: model.api,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    cost: structuredClone(model.cost),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.samplingParams ? { samplingParams: { ...model.samplingParams } } : {}),
    ...(model.promptCache ? { promptCache: { ...model.promptCache } } : {}),
    ...(model.inputLimits ? { inputLimits: structuredClone(model.inputLimits) } : {}),
    ...(model.compat ? { compat: structuredClone(model.compat) } : {}),
  }
}

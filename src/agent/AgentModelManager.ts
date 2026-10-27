import type { RuntimeModelDescriptor, RuntimeThinkingLevel } from '../runtime/contracts.ts'
import { toRuntimeModelDescriptor, type RuntimeModelSource } from '../runtime/modelProjection.ts'

export interface AgentModelSnapshot {
  readonly model: RuntimeModelDescriptor
  readonly provider: string
  readonly apiKeyConfigured: boolean
  readonly thinkingLevel: RuntimeThinkingLevel
}

export interface AgentModelConfig<Model extends RuntimeModelSource> {
  model: Model
  /** Provider credentials remain runtime-private and never enter snapshots. */
  apiKey: string
}

export class AgentModelManager<Model extends RuntimeModelSource> {
  private config: AgentModelConfig<Model>
  private thinkingLevel: RuntimeThinkingLevel
  private readonly resolveConfig: (
    modelId: string,
    api?: string,
    provider?: string,
  ) => AgentModelConfig<Model>
  private readonly resolveApiKeyForModel: (model: Model) => string | undefined

  constructor(options: AgentModelConfig<Model> & {
    thinkingLevel?: RuntimeThinkingLevel
    resolveModelConfig: (
      modelId: string,
      api?: string,
      provider?: string,
    ) => AgentModelConfig<Model>
    resolveApiKey?: (model: Model) => string | undefined
  }) {
    this.config = {
      model: options.model,
      apiKey: options.apiKey,
    }
    this.thinkingLevel = options.thinkingLevel ?? 'off'
    this.resolveConfig = options.resolveModelConfig
    this.resolveApiKeyForModel = options.resolveApiKey ?? (() => undefined)
  }

  resolve(modelId: string, api?: string, provider?: string): AgentModelConfig<Model> {
    return this.resolveConfig(modelId, api, provider)
  }

  commit(config: AgentModelConfig<Model>): void {
    this.config = config
  }

  getModel(): Model {
    return this.config.model
  }

  getApiKey(): string {
    return this.resolveApiKeyForModel(this.config.model) ?? this.config.apiKey
  }

  getProvider(): string {
    return this.config.model.provider
  }

  getThinkingLevel(): RuntimeThinkingLevel {
    return this.thinkingLevel
  }

  setThinkingLevel(level: RuntimeThinkingLevel): void {
    this.thinkingLevel = level
  }

  getSnapshot(): Readonly<AgentModelSnapshot> {
    return Object.freeze({
      model: toRuntimeModelDescriptor(this.config.model),
      provider: this.getProvider(),
      apiKeyConfigured: this.getApiKey().length > 0,
      thinkingLevel: this.thinkingLevel,
    })
  }
}

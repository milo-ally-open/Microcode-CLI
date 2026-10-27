import type { AssistantMessage, AssistantMessageEvent, Api, AuthType, AuthEvent, AuthPrompt, Context, Model, Models } from '@earendil-works/pi-ai'
import { createModelsForCwd, getAllModels, getConfiguredModel, getModels } from './index.ts'
import { getProviderAuthChoices } from './authChoices.ts'
import type { ModelProviderRuntime, ModelRuntimeOptions } from './runtime.ts'
import type { ModelAuthEvent, ModelAuthPrompt, ModelAuthType } from './contracts.ts'
import type { ModelRuntimeDescriptor } from './inference.ts'
import { toModelCompletion, toModelRuntimeDescriptor, toModelStreamEvent, toPiContext } from '../kernel/pi/modelAdapter.ts'

const reasoningSummaryApis = new Set(['openai-responses', 'openai-codex-responses', 'azure-openai-responses'])

function simpleOptions(options: ModelRuntimeOptions & { signal?: AbortSignal }) {
  return {
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.samplingParams === undefined ? {} : { samplingParams: options.samplingParams }),
    signal: options.signal,
  }
}

export function streamPiModel(models: Models, model: Model<Api>, context: Context, options: ModelRuntimeOptions & { signal?: AbortSignal }): AsyncIterable<AssistantMessageEvent> {
  if (options.reasoningSummary && reasoningSummaryApis.has(model.api)) {
    return models.stream(model, context, {
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
      reasoningSummary: options.reasoningSummary,
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...(options.samplingParams === undefined ? {} : { samplingParams: options.samplingParams }),
      signal: options.signal,
    } as any)
  }
  return models.streamSimple(model, context, simpleOptions(options))
}

export function completePiModel(models: Models, model: Model<Api>, context: Context, options: ModelRuntimeOptions & { signal?: AbortSignal }): Promise<AssistantMessage> {
  if (options.reasoningSummary && reasoningSummaryApis.has(model.api)) {
    return models.complete(model, context, {
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
      reasoningSummary: options.reasoningSummary,
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...(options.samplingParams === undefined ? {} : { samplingParams: options.samplingParams }),
      signal: options.signal,
    } as any)
  }
  return models.completeSimple(model, context, simpleOptions(options))
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().replace(/^models\//, '')
}

export function resolveGatewayModel(modelId: string, models = getAllModels()): Model<Api> | undefined {
  const requested = normalizeModelId(modelId)
  const slash = requested.indexOf('/')
  if (slash > 0) {
    const provider = requested.slice(0, slash)
    const id = requested.slice(slash + 1)
    return models.find((model) => String(model.provider) === provider && model.id === id)
  }
  const matches = models.filter((model) => model.id === requested)
  return matches.length === 1 ? matches[0] : undefined
}

interface ProjectModelCollection {
  fingerprint: string
  models: Models
  allModels: Model<Api>[]
}

/** Stateful adapter between the gateway runtime contract and Pi model collections. */
export class PiGatewayRuntime implements ModelProviderRuntime {
  private readonly modelCollections = new WeakMap<object, Models>()
  private readonly piModels = new WeakMap<object, Model<Api>>()
  private readonly projectCollections = new Map<string, ProjectModelCollection>()

  private describe(models: Models, entries: readonly Model<Api>[]): ModelRuntimeDescriptor[] {
    return entries.map((model) => {
      const descriptor = toModelRuntimeDescriptor(model)
      this.modelCollections.set(descriptor, models)
      this.piModels.set(descriptor, model)
      return descriptor
    })
  }

  private resolvePiModel(descriptor: ModelRuntimeDescriptor): Model<Api> {
    const remembered = this.piModels.get(descriptor)
    if (remembered) return remembered
    const model = resolveGatewayModel(descriptor.id, getAllModels())
    if (!model) throw new Error('The selected model is no longer available.')
    return model
  }

  private projectCollection(cwd: string): ProjectModelCollection {
    const fingerprint = 'initial-provider-allowlist-v1'
    const cached = this.projectCollections.get(cwd)
    if (cached?.fingerprint === fingerprint) {
      this.projectCollections.delete(cwd)
      this.projectCollections.set(cwd, cached)
      return cached
    }
    const scoped = createModelsForCwd(cwd)
    const entry = { fingerprint, ...scoped }
    this.projectCollections.set(cwd, entry)
    while (this.projectCollections.size > 8) this.projectCollections.delete(this.projectCollections.keys().next().value!)
    return entry
  }

  private collectionFor(cwd?: string): Models {
    return cwd ? this.projectCollection(cwd).models : getModels()
  }

  getModels(projectCwd?: string): readonly ModelRuntimeDescriptor[] {
    if (projectCwd) {
      const scoped = this.projectCollection(projectCwd)
      return this.describe(scoped.models, scoped.allModels)
    }
    const entries = getAllModels()
    return this.describe(getModels(), entries)
  }

  getCurrentModel(projectCwd?: string): ModelRuntimeDescriptor {
    const scoped = projectCwd ? this.projectCollection(projectCwd) : undefined
    const entries = scoped?.allModels ?? getAllModels()
    const model = getConfiguredModel(entries)
    return this.describe(scoped?.models ?? getModels(), [model])[0]!
  }

  getProviders(projectCwd?: string) {
    return this.collectionFor(projectCwd).getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      authChoices: getProviderAuthChoices(provider),
    }))
  }

  async checkAuth(providerId: string, projectCwd: string | undefined, signal: AbortSignal) {
    const auth = await this.collectionFor(projectCwd).checkAuth(providerId, { signal })
    return auth ? { type: auth.type } : undefined
  }

  async login(providerId: string, type: ModelAuthType, interaction: Parameters<ModelProviderRuntime['login']>[2], projectCwd?: string): Promise<void> {
    await this.collectionFor(projectCwd).login(providerId, type as AuthType, {
      signal: interaction.signal,
      prompt: (prompt: AuthPrompt) => interaction.prompt(prompt as unknown as ModelAuthPrompt),
      notify: (event: AuthEvent) => interaction.notify(event as unknown as ModelAuthEvent),
    })
  }

  async logout(providerId: string, projectCwd: string | undefined, signal: AbortSignal): Promise<void> {
    await this.collectionFor(projectCwd).logout(providerId, { signal })
  }

  resolveModel(id: string, projectCwd?: string): ModelRuntimeDescriptor | undefined {
    if (projectCwd) {
      const scoped = this.projectCollection(projectCwd)
      const model = resolveGatewayModel(id, scoped.allModels)
      return model ? this.describe(scoped.models, [model])[0] : undefined
    }
    const entries = getAllModels()
    const model = resolveGatewayModel(id, entries)
    return model ? this.describe(getModels(), [model])[0] : undefined
  }

  async *stream(model: ModelRuntimeDescriptor, context: import('./inference.ts').ModelInferenceContext, options: ModelRuntimeOptions & { signal?: AbortSignal }) {
    const piModel = this.resolvePiModel(model)
    const collection = this.modelCollections.get(model) ?? getModels()
    for await (const event of streamPiModel(collection, piModel, toPiContext(context), options)) {
      yield toModelStreamEvent(event)
    }
  }

  async complete(model: ModelRuntimeDescriptor, context: import('./inference.ts').ModelInferenceContext, options: ModelRuntimeOptions & { signal?: AbortSignal }) {
    const piModel = this.resolvePiModel(model)
    const collection = this.modelCollections.get(model) ?? getModels()
    return toModelCompletion(await completePiModel(collection, piModel, toPiContext(context), options))
  }
}

export function createPiGatewayRuntime(): ModelProviderRuntime {
  return new PiGatewayRuntime()
}

export type { AssistantMessage, AssistantMessageEvent, Context, Model }

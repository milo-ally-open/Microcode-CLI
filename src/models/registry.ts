/** Microcode model registry constrained to the reviewed provider set. */

import {
  createModels,
  type Api,
  type Model,
  type Models,
  type MutableModels,
} from '@earendil-works/pi-ai'
import { loadCustomModels, type CustomModelDef, getUnsupportedCustomModelDiagnostics } from './custom.ts'
import { createInitialModelProviders, INITIAL_MODEL_PROVIDER_REGISTRY } from './providers/index.ts'
import type { ModelCatalogSnapshot, ModelDescriptor, ModelProviderDescriptor } from './contracts.ts'
import { EncryptedCredentialStore } from './EncryptedCredentialStore.ts'

export interface ModelConfig {
  model: Model<Api>
  /** Legacy compatibility field; provider auth is resolved by Models at request time. */
  apiKey: string
}

function createModelCollection(): MutableModels {
  const models = createModels({ credentials: new EncryptedCredentialStore() })
  for (const provider of createInitialModelProviders()) models.setProvider(provider)
  return models
}

const modelCollection = createModelCollection()
let currentModel: Model<Api> | undefined

export function getModels(): Models {
  return modelCollection
}

/**
 * Build an isolated collection for project-scoped runtime RPC. Project custom
 * models are intentionally not registered; the configuration is retained and
 * reported through getModelConfigDiagnostics().
 */
export function createModelsForCwd(_cwd: string): { models: MutableModels; allModels: Model<Api>[] } {
  const models = createModelCollection()
  return { models, allModels: models.getModels().map(applyEnvOverrides) }
}

export function getAllModels(): Model<Api>[] {
  return modelCollection.getModels().map(applyEnvOverrides)
}

function toModelDescriptor(model: Model<Api>): ModelDescriptor {
  return Object.freeze({
    id: `${model.provider}/${model.id}`,
    providerId: String(model.provider),
    modelId: model.id,
    apiId: model.api,
    name: model.name,
    input: Object.freeze([...model.input]),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    reasoning: model.reasoning,
  })
}

/** Return client-safe provider/model metadata without Pi models or credentials. */
export function getModelCatalog(): ModelCatalogSnapshot {
  const models = getAllModels()
  const providers: ModelProviderDescriptor[] = []
  for (const provider of INITIAL_MODEL_PROVIDER_REGISTRY) {
    const entries = models.filter((model) => String(model.provider) === provider.id)
    if (entries.length === 0) continue
    providers.push(Object.freeze({
      id: provider.id,
      name: provider.name,
      adapterVersion: provider.version,
      authModes: Object.freeze([...provider.authModes]),
      supportedApis: Object.freeze([...provider.supportedApis]),
      models: Object.freeze(entries.map(toModelDescriptor)),
    }))
  }
  const exposedIds = new Set(providers.map((provider) => provider.id))
  const visibleModels = models.filter((model) => exposedIds.has(String(model.provider))).map(toModelDescriptor)
  return Object.freeze({ providers: Object.freeze(providers), models: Object.freeze(visibleModels) })
}

function applyEnvOverrides(model: Model<Api>): Model<Api> {
  const globalBase = process.env.BASE_URL
  if (globalBase) return { ...model, baseUrl: globalBase }

  const usesOpenAiApi = model.api === 'openai-completions' || model.api === 'openai-responses'
  const baseUrl = usesOpenAiApi ? process.env.OPENAI_BASE_URL : undefined
  return baseUrl ? { ...model, baseUrl } : model
}

export function getCustomModelDefs(): CustomModelDef[] {
  return loadCustomModels()
}

export function getModelConfigDiagnostics(cwd?: string): string[] {
  return getUnsupportedCustomModelDiagnostics(cwd)
}

const MODEL_ENV_KEYS = ['MODEL', 'OPENAI_MODEL', 'DEEPSEEK_MODEL'] as const

function envModel(): string | undefined {
  return MODEL_ENV_KEYS.map((key) => process.env[key]).find(Boolean)
}

/** Resolve the environment-selected/default model against an explicit catalog. */
export function getConfiguredModel(models: readonly Model<Api>[]): Model<Api> {
  const wanted = envModel() ?? 'deepseek-v4-pro'
  let candidates = models.filter((model) => model.id === wanted || String(model.provider) + '/' + model.id === wanted)
  if (candidates.length === 0) {
    candidates = models.filter((model) => model.id.includes(wanted) || wanted.includes(model.id))
  }
  if (candidates.length === 0) throw new Error('Model "' + wanted + '" was not found.')
  return candidates[0]!
}

export function getCurrentModel(): Model<Api> {
  if (currentModel) return currentModel
  currentModel = getConfiguredModel(getAllModels())
  return currentModel
}

export function setCurrentModel(model: Model<Api>): void {
  if (!getAllModels().some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
    throw new Error('Model provider is not enabled: ' + String(model.provider) + '/' + model.id)
  }
  currentModel = model
}

export function findModel(modelId: string, api?: Api, provider?: string): Model<Api> | undefined {
  const all = getAllModels()
  if (provider) return all.find((model) => model.id === modelId && model.provider === provider && (!api || model.api === api))
  if (api) return all.find((model) => model.id === modelId && model.api === api)
  return all.find((model) => String(model.provider) + '/' + model.id === modelId) ?? all.find((model) => model.id === modelId)
}

export function resolveApiKey(model: Pick<Model<Api>, 'provider'>): string | undefined {
  if (model.provider === 'openai') return process.env.OPENAI_API_KEY
  if (model.provider === 'deepseek') return process.env.DEEPSEEK_API_KEY
  return undefined
}

export function getModelConfig(modelId?: string, api?: Api, provider?: string): ModelConfig {
  const selected = modelId ? findModel(modelId, api, provider) : undefined
  if (modelId && !selected) throw new Error('Model "' + modelId + '" is not enabled or was not found.')
  const model = selected ?? getCurrentModel()
  return { model, apiKey: resolveApiKey(model) ?? '' }
}

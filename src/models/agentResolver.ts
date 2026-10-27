import { getAllModels, resolveApiKey } from './registry.ts'

/** Resolves the current Pi-backed catalog for the in-process Agent adapter. */
export function resolveAgentModelConfig(modelId: string, api?: string, provider?: string) {
  const allModels = getAllModels()
  let candidates = allModels.filter((model) => model.id === modelId || `${model.provider}/${model.id}` === modelId)
  if (candidates.length === 0) {
    candidates = allModels.filter(
      (model) => model.id.includes(modelId) || modelId.includes(model.id),
    )
  }
  if (api) candidates = candidates.filter((model) => model.api === api)
  if (provider) candidates = candidates.filter((model) => model.provider === provider)
  if (candidates.length === 0) {
    throw new Error(
      `Model "${modelId}"${api ? ` with API "${api}"` : ''} was not found.`,
    )
  }
  const model = candidates[0]
  return {
    model,
    apiKey: resolveApiKey(model) ?? '',
  }
}

/** Kept in the model adapter because credential resolution is provider-specific. */
export function resolveAgentModelApiKey(model: { provider: string }): string | undefined {
  return resolveApiKey(model)
}

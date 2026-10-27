import type { RuntimeModelDescriptor } from './contracts.ts'

export interface RuntimeModelSource {
  id: string
  provider: string
  api: string
  name: string
  input: readonly string[]
  contextWindow: number
  maxTokens: number
  reasoning: boolean
}

/** Projects model metadata into the Pi-free runtime/client contract. */
export function toRuntimeModelDescriptor(model: RuntimeModelSource): RuntimeModelDescriptor {
  return Object.freeze({
    id: `${model.provider}/${model.id}`,
    provider_id: model.provider,
    model_id: model.id,
    api_id: model.api,
    name: model.name,
    input: Object.freeze([...model.input]),
    context_window: model.contextWindow,
    max_output_tokens: model.maxTokens,
    reasoning: model.reasoning,
  })
}

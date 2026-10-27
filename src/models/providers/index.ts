import type { ModelProviderAdapter } from './types.ts'
import { deepSeekModelProvider } from './deepseek.ts'
import { openAiGptModelProvider } from './openai.ts'
import { openAiCodexModelProvider } from './openai-codex.ts'
import { createModelProviders } from './registry.ts'

/** Static contributions are the only providers that may enter the runtime catalog. */
export const INITIAL_MODEL_PROVIDER_REGISTRY: readonly ModelProviderAdapter[] = Object.freeze([
  openAiCodexModelProvider,
  openAiGptModelProvider,
  deepSeekModelProvider,
])

export { createModelProviders } from './registry.ts'
export type { ModelProviderAdapter } from './types.ts'

export function createInitialModelProviders() {
  return createModelProviders(INITIAL_MODEL_PROVIDER_REGISTRY)
}

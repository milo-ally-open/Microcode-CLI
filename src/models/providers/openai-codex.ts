import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { ModelProviderAdapter } from './types.ts'

export const openAiCodexModelProvider: ModelProviderAdapter = Object.freeze({
  id: 'openai-codex',
  name: 'OpenAI Codex',
  version: 1,
  authModes: ['oauth'] as const,
  supportedApis: ['openai-codex-responses'] as const,
  createPiProvider: openaiCodexProvider,
})

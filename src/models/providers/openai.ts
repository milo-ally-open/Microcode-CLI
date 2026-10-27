import type { Provider } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { ModelProviderAdapter } from './types.ts'

function openaiGptProvider(): Provider {
  const provider = openaiProvider()
  return {
    ...provider,
    getModels: () => provider.getModels().filter((model) =>
      model.id.startsWith('gpt-') && !model.id.startsWith('gpt-realtime-'),
    ),
  }
}

export const openAiGptModelProvider: ModelProviderAdapter = Object.freeze({
  id: 'openai',
  name: 'OpenAI GPT',
  version: 1,
  authModes: ['api_key'] as const,
  supportedApis: ['openai-responses'] as const,
  createPiProvider: openaiGptProvider,
})

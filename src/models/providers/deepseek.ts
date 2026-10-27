import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import type { ModelProviderAdapter } from './types.ts'

export const deepSeekModelProvider: ModelProviderAdapter = Object.freeze({
  id: 'deepseek',
  name: 'DeepSeek',
  version: 1,
  authModes: ['api_key'] as const,
  supportedApis: ['openai-completions'] as const,
  createPiProvider: deepseekProvider,
})

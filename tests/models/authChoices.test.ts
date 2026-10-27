import { describe, expect, test } from 'bun:test'
import { getProviderAuthChoices } from '../../src/models/authChoices.ts'
import { createModelProviders, INITIAL_MODEL_PROVIDER_REGISTRY } from '../../src/models/providers/index.ts'
import { getModels } from '../../src/models/registry.ts'

describe('provider authentication choices', () => {
  const providers = getModels().getProviders()

  test('registers only the initial approved model providers', () => {
    expect(providers.map((provider) => provider.id).sort()).toEqual([
      'deepseek',
      'openai',
      'openai-codex',
    ])
    expect(getModels().getProvider('anthropic')).toBeUndefined()
    expect(getModels().getProvider('google')).toBeUndefined()
  })

  test('declares only the upstream APIs provided by each approved provider', () => {
    expect(providers.map((provider) => [
      provider.id,
      [...new Set(provider.getModels().map((model) => model.api))].sort(),
    ]).sort(([left], [right]) => String(left).localeCompare(String(right)))).toEqual([
      ['deepseek', ['openai-completions']],
      ['openai', ['openai-responses']],
      ['openai-codex', ['openai-codex-responses']],
    ])
  })

  test('limits OpenAI API-key access to GPT models', () => {
    const models = getModels().getProvider('openai')!.getModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.id.startsWith('gpt-') && !model.id.startsWith('gpt-realtime-'))).toBe(true)
    expect(models.some((model) => model.id === 'o3')).toBe(false)
  })

  test('rejects duplicate IDs, mismatched auth declarations, and unsupported model APIs', () => {
    const openai = INITIAL_MODEL_PROVIDER_REGISTRY.find(({ id }) => id === 'openai')!
    expect(() => createModelProviders([openai, openai])).toThrow('Duplicate model provider registration')
    expect(() => createModelProviders([{ ...openai, authModes: ['oauth'] }])).toThrow('auth declaration')
    expect(() => createModelProviders([{ ...openai, version: 0 }])).toThrow('adapter version')
    expect(() => createModelProviders([{ ...openai, name: ' ' }])).toThrow('display name')

    const provider = openai.createPiProvider()
    const unsupported = {
      ...openai,
      createPiProvider: () => ({
        ...provider,
        getModels: () => provider.getModels().map((model) => ({ ...model, api: 'google-generative-ai' })) as any,
      }),
    }
    expect(() => createModelProviders([unsupported])).toThrow('Unsupported upstream API')
  })

  test('Codex exposes OAuth only and API-key providers expose API key only', () => {
    const codex = providers.find((provider) => provider.id === 'openai-codex')!
    const openai = providers.find((provider) => provider.id === 'openai')!
    const deepseek = providers.find((provider) => provider.id === 'deepseek')!

    expect(getProviderAuthChoices(codex).map((choice) => choice.value)).toEqual(['oauth'])
    expect(codex.auth.apiKey).toBeUndefined()
    expect(getProviderAuthChoices(openai).map((choice) => choice.value)).toEqual(['api_key'])
    expect(openai.auth.oauth).toBeUndefined()
    expect(getProviderAuthChoices(deepseek).map((choice) => choice.value)).toEqual(['api_key'])
    expect(deepseek.auth.oauth).toBeUndefined()
  })
})

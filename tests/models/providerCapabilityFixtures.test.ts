import { describe, expect, test } from 'bun:test'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { createGatewayServer } from '../../src/daemon/server.ts'
import type { GatewayModelRuntime, GatewayServerHandle } from '../../src/daemon/types.ts'
import type { ModelCompletion, ModelInferenceContext, ModelRuntimeDescriptor } from '../../src/models/inference.ts'
import { getModelAuthProviders, getModelAuthStatus, loginModelProvider, logoutModelProvider } from '../../src/models/authFacade.ts'
import { getModelCatalog } from '../../src/models/registry.ts'

const fixtureUrl = new URL('../fixtures/models/provider-capabilities.expected.json', import.meta.url)

describe('fixed provider capability fixtures', () => {
  test('matches the pinned provider/API/auth and representative model capability matrix', async () => {
    const fixture = await Bun.file(fixtureUrl).json() as {
      piAiVersion: string
      providers: Array<{
        id: string
        authModes: string[]
        api: string
        models: Array<{ id: string; input: string[]; reasoning: boolean; contextWindow: number; maxOutputTokens: number }>
      }>
    }
    const installedPiAi = await Bun.file(new URL('../../node_modules/@earendil-works/pi-ai/package.json', import.meta.url)).json() as { version: string }
    const catalog = getModelCatalog()

    expect(installedPiAi.version).toBe(fixture.piAiVersion)
    expect(catalog.providers.map((provider) => provider.id)).toEqual(fixture.providers.map((provider) => provider.id))
    for (const expectedProvider of fixture.providers) {
      const provider = catalog.providers.find((entry) => entry.id === expectedProvider.id)!
      expect([...provider.authModes]).toEqual(expectedProvider.authModes)
      expect([...provider.supportedApis]).toEqual([expectedProvider.api])
      for (const expectedModel of expectedProvider.models) {
        const actual = catalog.models.find((entry) => entry.providerId === expectedProvider.id && entry.modelId === expectedModel.id)
        expect(actual).toMatchObject({
          apiId: expectedProvider.api,
          input: expectedModel.input,
          reasoning: expectedModel.reasoning,
          contextWindow: expectedModel.contextWindow,
          maxOutputTokens: expectedModel.maxOutputTokens,
        })
      }
    }
  })

  test('exercises API-key and OAuth auth fixtures without vendor calls or secret disclosure', async () => {
    for (const [providerId, createProvider, promptLabel] of [
      ['openai', openaiProvider, 'Enter OpenAI API key'],
      ['deepseek', deepseekProvider, 'Enter DeepSeek API key'],
    ] as const) {
      const models = createModels({ credentials: new InMemoryCredentialStore() })
      models.setProvider(createProvider())
      const prompts: string[] = []
      const interaction = {
        signal: new AbortController().signal,
        async prompt(prompt: { type: string; message: string }) {
          prompts.push(prompt.type + ':' + prompt.message)
          return providerId + '-fixture-secret'
        },
        notify() {},
      }

      expect(getModelAuthProviders(models).find((provider) => provider.id === providerId)?.authChoices.map((choice) => choice.value)).toEqual(['api_key'])
      await loginModelProvider(providerId, 'api_key', interaction, models)
      expect(prompts).toEqual(['secret:' + promptLabel])
      expect(await getModelAuthStatus(undefined, models)).toEqual([{ providerId, configured: true, type: 'api_key' }])
      expect(JSON.stringify(await getModelAuthStatus(undefined, models))).not.toContain('fixture-secret')
      await logoutModelProvider(providerId, undefined, models)
      expect(await getModelAuthStatus(undefined, models)).toEqual([{ providerId, configured: false }])
    }

    const models = createModels({ credentials: new InMemoryCredentialStore() })
    const codex = openaiCodexProvider()
    const oauth = codex.auth.oauth!
    const credential = {
      type: 'oauth' as const,
      access: 'codex-fixture-access-secret',
      refresh: 'codex-fixture-refresh-secret',
      expires: Date.now() + 60_000,
      accountId: 'fixture-account',
    }
    models.setProvider({
      ...codex,
      auth: {
        oauth: {
          ...oauth,
          async login() { return credential },
        },
      },
    })
    const notifications: unknown[] = []
    await loginModelProvider('openai-codex', 'oauth', {
      signal: new AbortController().signal,
      async prompt() { throw new Error('The offline OAuth fixture must not prompt or access a vendor.') },
      notify(event) { notifications.push(event) },
    }, models)
    expect(getModelAuthProviders(models).find((provider) => provider.id === 'openai-codex')?.authChoices.map((choice) => choice.value)).toEqual(['oauth'])
    expect(await getModelAuthStatus(undefined, models)).toEqual([{ providerId: 'openai-codex', configured: true, type: 'oauth' }])
    expect(JSON.stringify(await getModelAuthStatus(undefined, models))).not.toContain('fixture-access-secret')
    expect(notifications).toEqual([])
    await logoutModelProvider('openai-codex', undefined, models)
    expect(await getModelAuthStatus(undefined, models)).toEqual([{ providerId: 'openai-codex', configured: false }])
  })

  test('rejects image and reasoning requests when the selected model fixture lacks that capability', async () => {
    const cases = await Bun.file(new URL('../fixtures/models/capability-rejections.expected.json', import.meta.url)).json() as Array<{
      modelId: string
      feature: 'image' | 'reasoning'
      status: number
      message: string
    }>
    const catalog = getModelCatalog()
    for (const expected of cases) {
      const entry = catalog.models.find((candidate) => candidate.id === expected.modelId)!
      const runtimeModel: ModelRuntimeDescriptor = {
        id: entry.modelId,
        provider: entry.providerId,
        name: entry.name,
        api: entry.apiId,
        input: [...entry.input],
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxOutputTokens,
        reasoning: entry.reasoning,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
      let inferenceCalls = 0
      const runtime: GatewayModelRuntime = {
        getModels: () => [runtimeModel],
        getCurrentModel: () => runtimeModel,
        getProviders: () => [],
        checkAuth: async () => undefined,
        login: async () => undefined,
        logout: async () => undefined,
        resolveModel: () => runtimeModel,
        async *stream() { inferenceCalls++ },
        async complete(_model, _context: ModelInferenceContext): Promise<ModelCompletion> {
          inferenceCalls++
          throw new Error('Inference must not start for an unsupported capability.')
        },
      }
      const handle: GatewayServerHandle = createGatewayServer({ token: 'provider-capability-token', rpcToken: 'private-capability-token', runtime, port: 0 })
      try {
        const payload = expected.feature === 'image'
          ? { model: expected.modelId, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] }
          : { model: expected.modelId, messages: [{ role: 'user', content: 'Reason with care.' }], reasoning_effort: 'high' }
        const response = await fetch('http://' + handle.hostname + ':' + handle.port + '/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: 'Bearer provider-capability-token', 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const body = await response.json() as { error: { message: string } }
        expect(response.status).toBe(expected.status)
        expect(body.error.message).toBe(expected.message)
        expect(inferenceCalls).toBe(0)
      } finally {
        await handle.stop()
      }
    }
  })
})

import { describe, expect, test } from 'bun:test'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { getModelAuthProviders, getModelAuthStatus, loginModelProvider, logoutModelProvider } from '../../src/models/authFacade.ts'
import { createPiGatewayRuntime } from '../../src/models/piRuntime.ts'

describe('model provider runtime', () => {
  test('API-key auth facade performs a secret prompt, persists status, and logs out without returning the key', async () => {
    const models = createModels({ credentials: new InMemoryCredentialStore() })
    models.setProvider(deepseekProvider())
    const prompts: string[] = []
    const notifications: string[] = []
    const interaction = {
      signal: new AbortController().signal,
      async prompt(prompt: { type: string; message: string }) {
        prompts.push(`${prompt.type}:${prompt.message}`)
        return 'test-provider-key'
      },
      notify(event: { type: string; message?: string }) {
        notifications.push(`${event.type}:${event.message ?? ''}`)
      },
    }

    expect(getModelAuthProviders(models).map((provider) => ({ id: provider.id, choices: provider.authChoices.map((choice) => choice.value) })))
      .toEqual([{ id: 'deepseek', choices: ['api_key'] }])
    await loginModelProvider('deepseek', 'api_key', interaction, models)

    expect(prompts).toEqual(['secret:Enter DeepSeek API key'])
    expect(JSON.stringify(await getModelAuthStatus(undefined, models))).not.toContain('test-provider-key')
    expect(await getModelAuthStatus(undefined, models)).toEqual([{ providerId: 'deepseek', configured: true, type: 'api_key' }])
    expect(notifications).toEqual([])

    await logoutModelProvider('deepseek', undefined, models)
    expect(await getModelAuthStatus(undefined, models)).toEqual([{ providerId: 'deepseek', configured: false }])
  })

  test('pinned Pi DeepSeek provider authenticates and streams through the neutral runtime facade', async () => {
    const previous = {
      base: process.env.BASE_URL,
      openaiBase: process.env.OPENAI_BASE_URL,
      deepseekKey: process.env.DEEPSEEK_API_KEY,
    }
    const observed: { path?: string; authorization?: string; model?: string } = {}
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        observed.path = new URL(request.url).pathname
        observed.authorization = request.headers.get('authorization') ?? undefined
        const body = await request.json() as { model?: string }
        observed.model = body.model
        const frames = [
          { id: 'chatcmpl-fixture', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          { id: 'chatcmpl-fixture', choices: [{ index: 0, delta: { content: 'provider stream fixture' }, finish_reason: null }] },
          { id: 'chatcmpl-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
        ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
        return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
      },
    })

    try {
      delete process.env.BASE_URL
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`
      process.env.DEEPSEEK_API_KEY = 'runtime-provider-smoke-key'
      const runtime = createPiGatewayRuntime()
      const model = runtime.resolveModel('deepseek/deepseek-v4-pro')
      expect(model).toBeDefined()
      const events = []
      for await (const event of runtime.stream(model!, {
        messages: [{ role: 'user', content: 'hello provider', timestamp: 1 }],
      }, { signal: new AbortController().signal })) events.push(event)

      expect(observed.path).toBe('/v1/chat/completions')
      expect(observed.authorization).toBe('Bearer runtime-provider-smoke-key')
      expect(observed.model).toBe('deepseek-v4-pro')
      expect(events.some((event) => event.type === 'text_delta' && event.delta === 'provider stream fixture')).toBe(true)
      expect(events.some((event) => event.type === 'done')).toBe(true)
      expect(JSON.stringify(events)).not.toContain('runtime-provider-smoke-key')
    } finally {
      server.stop(true)
      if (previous.base === undefined) delete process.env.BASE_URL
      else process.env.BASE_URL = previous.base
      if (previous.openaiBase === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previous.openaiBase
      if (previous.deepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previous.deepseekKey
    }
  })
})

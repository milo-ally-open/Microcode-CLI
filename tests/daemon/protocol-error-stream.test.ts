import { describe, expect, test } from 'bun:test'
import { createGatewayServer } from '../../src/daemon/server.ts'
import type { GatewayModelRuntime, GatewayServerHandle } from '../../src/daemon/types.ts'
import type { ModelCompletion, ModelRuntimeDescriptor, ModelStreamEvent } from '../../src/models/inference.ts'

const TOKEN = 'protocol-error-fixture-token'
const model: ModelRuntimeDescriptor = {
  id: 'deepseek-v4-pro',
  name: 'DeepSeek V4 Pro fixture',
  provider: 'deepseek',
  api: 'openai-completions',
  input: ['text'],
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function failedCompletion(): ModelCompletion {
  return {
    content: [],
    apiId: model.api,
    providerId: model.provider,
    modelId: model.id,
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error',
    errorMessage: 'sensitive provider error detail',
    timestamp: 1_700_000_000_000,
  }
}

function runtime(): GatewayModelRuntime {
  return {
    getModels: () => [model],
    getCurrentModel: () => model,
    getProviders: () => [],
    checkAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    resolveModel: (id) => id === 'deepseek/deepseek-v4-pro' || id === 'deepseek-v4-pro' ? model : undefined,
    async *stream() {
      const partial = failedCompletion()
      yield { type: 'start', partial } as ModelStreamEvent
      yield { type: 'error', reason: 'sensitive provider error detail', error: partial } as ModelStreamEvent
    },
    async complete() { return failedCompletion() },
  }
}

function frameLabels(dialect: string, text: string): string[] {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const event = /^event: ([^\r\n]+)/m.exec(frame)?.[1]
    if (event) return event
    const data = /^data: (.+)$/m.exec(frame)?.[1]
    if (data === '[DONE]') return 'done_marker'
    const parsed = JSON.parse(data ?? '{}') as Record<string, any>
    if (dialect === 'openai-chat') return parsed.choices?.[0]?.delta?.role === 'assistant' ? 'assistant_role' : parsed.error?.type ?? 'unexpected'
    return parsed.error ? 'error' : 'unexpected'
  })
}

describe('Gateway protocol stream error fixtures', () => {
  test('sends dialect-specific terminal errors without forwarding provider details', async () => {
    const expected = await Bun.file(new URL('../fixtures/protocols/stream-errors.expected.json', import.meta.url)).json() as Record<string, string[]>
    const requests: Record<string, { route: string; body: unknown; auth: Record<string, string> }> = {
      'openai-chat': {
        route: '/v1/chat/completions',
        body: { model: 'deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'fail' }], stream: true },
        auth: { authorization: 'Bearer ' + TOKEN },
      },
      'openai-responses': {
        route: '/v1/responses',
        body: { model: 'deepseek/deepseek-v4-pro', input: 'fail', stream: true },
        auth: { authorization: 'Bearer ' + TOKEN },
      },
      'gemini-generate': {
        route: '/v1beta/models/deepseek/deepseek-v4-pro:streamGenerateContent',
        body: { contents: [{ role: 'user', parts: [{ text: 'fail' }] }] },
        auth: { 'x-goog-api-key': TOKEN },
      },
      'anthropic-messages': {
        route: '/v1/messages',
        body: { model: 'deepseek/deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'fail' }], stream: true },
        auth: { 'x-api-key': TOKEN },
      },
    }

    for (const [dialect, request] of Object.entries(requests)) {
      const handle: GatewayServerHandle = createGatewayServer({ token: TOKEN, rpcToken: 'private-error-fixture', runtime: runtime(), port: 0 })
      try {
        const response = await fetch('http://' + handle.hostname + ':' + handle.port + request.route, {
          method: 'POST',
          headers: { ...request.auth, 'content-type': 'application/json' },
          body: JSON.stringify(request.body),
        })
        const body = await response.text()
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        expect(frameLabels(dialect, body)).toEqual(expected[dialect])
        expect(body).toContain('The model request failed.')
        expect(body).not.toContain('sensitive provider error detail')
      } finally {
        await handle.stop()
      }
    }
  })
})

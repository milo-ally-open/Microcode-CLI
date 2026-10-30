import { describe, expect, test } from 'bun:test'
import OpenAI from 'openai'
import { createGatewayServer } from '../../src/daemon/server.ts'
import type { GatewayModelRuntime, GatewayRequestOptions, GatewayServerHandle } from '../../src/daemon/types.ts'
import type { ModelCompletion, ModelInferenceContext, ModelRuntimeDescriptor } from '../../src/models/inference.ts'

const TOKEN = 'openai-sdk-local-smoke-token'
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

function completion(): ModelCompletion {
  return {
    content: [{ type: 'text', text: 'local Gateway smoke succeeded' }],
    apiId: model.api,
    providerId: model.provider,
    modelId: model.id,
    usage: { input: 5, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
  }
}

function runtimeFixture() {
  const calls: Array<{ context: ModelInferenceContext; options: GatewayRequestOptions }> = []
  const runtime: GatewayModelRuntime = {
    getModels: () => [model],
    getCurrentModel: () => model,
    getProviders: () => [],
    checkAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    resolveModel: (id) => id === 'deepseek/deepseek-v4-pro' || id === 'deepseek-v4-pro' ? model : undefined,
    async *stream() {},
    async complete(_selectedModel, context, options) {
      calls.push({ context, options })
      return completion()
    },
  }
  return { runtime, calls }
}

describe('fixed OpenAI SDK client smoke', () => {
  test('uses the pinned SDK for one successful supported Gateway request', async () => {
    const expectedVersion = (await Bun.file(new URL('../fixtures/clients/openai-sdk.version.txt', import.meta.url)).text()).trim()
    const installed = await Bun.file(new URL('../../node_modules/openai/package.json', import.meta.url)).json() as { version: string }
    expect(expectedVersion).toBe('openai 6.40.0')
    expect(installed.version).toBe(expectedVersion.replace('openai ', ''))

    const runtimeState = runtimeFixture()
    const handle: GatewayServerHandle = createGatewayServer({
      token: TOKEN,
      rpcToken: 'private-local-smoke-token',
      runtime: runtimeState.runtime,
      port: 0,
    })
    const client = new OpenAI({
      apiKey: TOKEN,
      baseURL: 'http://' + handle.hostname + ':' + handle.port + '/v1',
      maxRetries: 0,
    })
    try {
      const response = await client.chat.completions.create({
        model: 'deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Return a local smoke response.' }],
      })
      expect(response.choices[0]?.message.content).toBe('local Gateway smoke succeeded')
      expect(response.choices[0]?.finish_reason).toBe('stop')
      expect(response.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 })
      expect(runtimeState.calls).toHaveLength(1)
      expect(runtimeState.calls[0]?.context.messages).toMatchObject([{ role: 'user', content: 'Return a local smoke response.' }])
      expect(JSON.stringify(response)).not.toContain(TOKEN)
    } finally {
      await handle.stop()
    }
  })
})

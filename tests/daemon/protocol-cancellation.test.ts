import { describe, expect, test } from 'bun:test'
import { createConnection } from 'node:net'
import { createGatewayServer } from '../../src/daemon/server.ts'
import type { GatewayModelRuntime, GatewayServerHandle } from '../../src/daemon/types.ts'
import type { ModelCompletion, ModelRuntimeDescriptor, ModelStreamEvent } from '../../src/models/inference.ts'

const TOKEN = 'protocol-cancellation-fixture-token'
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
    content: [{ type: 'text', text: 'ready' }],
    apiId: model.api,
    providerId: model.provider,
    modelId: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
  }
}

function createBlockingRuntime(onStart: (signal: AbortSignal) => void): GatewayModelRuntime {
  return {
    getModels: () => [model],
    getCurrentModel: () => model,
    getProviders: () => [],
    checkAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    resolveModel: (id) => id === 'deepseek/deepseek-v4-pro' || id === 'deepseek-v4-pro' ? model : undefined,
    async *stream(_selected, _context, options) {
      const partial = completion()
      const signal = options.signal!
      onStart(signal)
      yield { type: 'start', partial } as ModelStreamEvent
      yield { type: 'text_delta', contentIndex: 0, delta: 'ready', partial } as ModelStreamEvent
      if (signal.aborted) return
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
    async complete() { return completion() },
  }
}

function openAndDisconnect(handle: GatewayServerHandle, route: string, body: unknown, authHeader: string, providerStarted: Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: handle.hostname, port: handle.port }, () => {
      const serialized = JSON.stringify(body)
      socket.write([
        'POST ' + route + ' HTTP/1.1',
        'Host: ' + handle.hostname + ':' + handle.port,
        authHeader,
        'Content-Type: application/json',
        'Content-Length: ' + Buffer.byteLength(serialized),
        'Connection: close',
        '',
        serialized,
      ].join('\r\n'))
    })
    let buffer = ''
    let hasBody = false
    let hasProviderStarted = false
    const disconnect = () => {
      if (!hasBody || !hasProviderStarted) return
      socket.destroy()
      resolve()
    }
    providerStarted.then(() => {
      hasProviderStarted = true
      disconnect()
    }, reject)
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd >= 0 && buffer.length > headerEnd + 4) {
        hasBody = true
        disconnect()
      }
    })
    socket.on('error', reject)
    socket.setTimeout(3_000, () => {
      socket.destroy()
      reject(new Error('Timed out waiting for the gateway to emit an SSE frame.'))
    })
  })
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The gateway did not abort provider work after client disconnect.')), 2_000)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

describe('Gateway protocol cancellation fixtures', () => {
  test('disconnecting any dialect cancels the active provider stream', async () => {
    const expected = await Bun.file(new URL('../fixtures/protocols/cancellation.expected.json', import.meta.url)).json() as Record<string, { route: string; abortsProvider: boolean }>
    const requests: Record<string, { body: unknown; authHeader: string }> = {
      'openai-chat': {
        body: { model: 'deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'wait' }], stream: true },
        authHeader: 'Authorization: Bearer ' + TOKEN,
      },
      'openai-responses': {
        body: { model: 'deepseek/deepseek-v4-pro', input: 'wait', stream: true },
        authHeader: 'Authorization: Bearer ' + TOKEN,
      },
      'gemini-generate': {
        body: { contents: [{ role: 'user', parts: [{ text: 'wait' }] }] },
        authHeader: 'x-goog-api-key: ' + TOKEN,
      },
      'anthropic-messages': {
        body: { model: 'deepseek/deepseek-v4-pro', max_tokens: 16, messages: [{ role: 'user', content: 'wait' }], stream: true },
        authHeader: 'x-api-key: ' + TOKEN,
      },
    }

    for (const [dialect, contract] of Object.entries(expected)) {
      let captured: AbortSignal | undefined
      let resolveStarted!: () => void
      const started = new Promise<void>((resolve) => { resolveStarted = resolve })
      const runtime = createBlockingRuntime((signal) => {
        captured = signal
        resolveStarted()
      })
      const handle = createGatewayServer({ token: TOKEN, rpcToken: 'private-fixture', runtime, port: 0 })
      try {
        const request = requests[dialect]!
        await openAndDisconnect(handle, contract.route, request.body, request.authHeader, started)
        expect(captured).toBeDefined()
        await waitForAbort(captured!)
        expect(captured!.aborted).toBe(contract.abortsProvider)
      } finally {
        await handle.stop()
      }
    }
  })
})

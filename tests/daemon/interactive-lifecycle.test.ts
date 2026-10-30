import { describe, expect, test } from 'bun:test'
import type { RuntimeConnection } from '../../src/daemon/runtime-service/lifecycle.ts'
import { shutdownInteractiveDaemons } from '../../src/daemon/interactiveLifecycle.ts'

function fakeConnection(calls: string[]): RuntimeConnection {
  return {
    key: 'runtime-key',
    baseUrl: 'http://127.0.0.1:43128',
    token: 'test-token',
    sessionId: 'session-a',
    cwd: process.cwd(),
    metadata: {
      state: 'ready',
      pid: 42,
      hostname: '127.0.0.1',
      port: 43128,
      protocolVersion: 1,
      startedAt: Date.now(),
      cwd: process.cwd(),
      sessionId: 'session-a',
    },
    client: {
      sendCommand: async (_sessionId: string, type: string) => {
        calls.push(`command:${type}`)
      },
    } as RuntimeConnection['client'],
  }
}

describe('interactive daemon shutdown', () => {
  test('aborts the active turn, stops runtime, then stops the transient gateway', async () => {
    const calls: string[] = []
    await shutdownInteractiveDaemons(fakeConnection(calls), 'session-a', {
      stopRuntime: async () => { calls.push('runtime'); return true },
      stopGateway: async () => { calls.push('gateway'); return true },
    })

    expect(calls).toEqual(['command:abort', 'runtime', 'gateway'])
  })

  test('attempts gateway shutdown even when runtime shutdown fails', async () => {
    const calls: string[] = []
    await expect(shutdownInteractiveDaemons(fakeConnection(calls), 'session-a', {
      stopRuntime: async () => { calls.push('runtime'); throw new Error('runtime failed') },
      stopGateway: async () => { calls.push('gateway'); return true },
    })).rejects.toMatchObject({ name: 'AggregateError' })

    expect(calls).toEqual(['command:abort', 'runtime', 'gateway'])
  })
})

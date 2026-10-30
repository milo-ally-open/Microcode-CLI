import { describe, expect, test } from 'bun:test'
import type { RuntimeAgentSnapshot, RuntimeEventEnvelope } from '../../src/runtime/contracts.ts'
import { RuntimeClientSession } from '../../src/runtime/client.ts'
import { RuntimeServiceClient, RuntimeServiceClientError } from '../../src/runtime/transportClient.ts'

function testSnapshot(version: number, pluginNames: readonly string[] = []): RuntimeAgentSnapshot {
  return {
    tools: { version, tools: [] },
    messages: [],
    model: {},
    capabilities: { plugins: pluginNames.map((name) => ({ name })) },
  } as unknown as RuntimeAgentSnapshot
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    signal?.addEventListener('abort', () => resolve(), { once: true })
  })
}

describe('RuntimeClientSession recovery contracts', () => {
  test('refreshes a stale tool snapshot and retries the requested mutation once', async () => {
    let version = 1
    const expectedVersions: number[] = []
    const client = {
      handshake: async () => ({ protocolVersion: 1 }),
      getSnapshotEnvelope: async () => ({ snapshot: testSnapshot(version), sequence: version }),
      sendCommand: async (_sessionId: string, _type: string, payload: Record<string, unknown>) => {
        const expectedVersion = payload.expected_version as number
        expectedVersions.push(expectedVersion)
        if (expectedVersion !== version) {
          throw new RuntimeServiceClientError('Tool snapshot is stale.', 409, 'stale_tool_snapshot')
        }
        version += 1
        return { version }
      },
      async *events(_sessionId: string, _sequence: number, signal?: AbortSignal) {
        await waitForAbort(signal)
      },
    } as unknown as RuntimeServiceClient
    const session = new RuntimeClientSession(client, 'session-a')
    try {
      await session.start()
      version = 2 // Another client committed after this session loaded its snapshot.
      const result = await session.sendCommand<{ version: number }>('tool.set', {
        tool_id: 'WebFetch',
        enabled: true,
        expected_version: 1,
      })

      expect(expectedVersions).toEqual([1, 2])
      expect(result).toEqual({ version: 3 })
      expect(session.snapshot?.tools.version).toBe(3)
      expect(session.lastSequence).toBe(2)
    } finally {
      await session.close()
    }
  })

  test('loads the new capability snapshot before notifying TUI event subscribers', async () => {
    let pluginNames: readonly string[] = []
    let sequence = 0
    const event: RuntimeEventEnvelope = {
      protocol_version: 1,
      session_id: 'session-b',
      sequence: 1,
      type: 'capabilities_changed',
      payload: { mcp_server_count: 0 },
    }
    const client = {
      handshake: async () => ({ protocolVersion: 1 }),
      getSnapshotEnvelope: async () => ({ snapshot: testSnapshot(sequence, pluginNames), sequence }),
      async *events(_sessionId: string, _lastSequence: number, signal?: AbortSignal) {
        pluginNames = ['scope-updated-plugin']
        sequence = 4
        yield event
        await waitForAbort(signal)
      },
    } as unknown as RuntimeServiceClient
    const session = new RuntimeClientSession(client, 'session-b')
    let resolveObserved!: () => void
    const observed = new Promise<void>((resolve) => { resolveObserved = resolve })
    session.subscribe({
      onEvent: (received) => {
        if (received.type !== 'capabilities_changed') return
        expect(session.snapshot?.capabilities.plugins).toEqual([{ name: 'scope-updated-plugin' }])
        expect(session.lastSequence).toBe(4)
        resolveObserved()
      },
    })
    try {
      await session.start()
      await observed
    } finally {
      await session.close()
    }
  })

  test('recovers its event stream and snapshot after a multi-second service outage', async () => {
    let online = true
    let snapshotCalls = 0
    let streamCalls = 0
    let releaseInitialStream!: () => void
    const disconnect = new Promise<void>((resolve) => { releaseInitialStream = resolve })
    let resolveInitialStream!: () => void
    const initialStream = new Promise<void>((resolve) => { resolveInitialStream = resolve })
    let resolveDisconnected!: () => void
    const disconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve })
    let resolveReconnected!: () => void
    const reconnected = new Promise<void>((resolve) => { resolveReconnected = resolve })
    let resolveRecoveredEvent!: () => void
    const recoveredEvent = new Promise<void>((resolve) => { resolveRecoveredEvent = resolve })
    const client = {
      handshake: async () => ({ protocolVersion: 1 }),
      getSnapshotEnvelope: async () => {
        snapshotCalls += 1
        if (!online) throw new Error('runtime service unavailable')
        return { snapshot: testSnapshot(snapshotCalls), sequence: 0 }
      },
      async *events(_sessionId: string, _lastSequence: number, signal?: AbortSignal) {
        streamCalls += 1
        if (streamCalls === 1) {
          resolveInitialStream()
          await disconnect
          throw new Error('runtime service stopped')
        }
        if (!online) throw new Error('runtime service unavailable')
        yield {
          protocol_version: 1,
          session_id: 'session-c',
          sequence: 1,
          type: 'agent_start',
          payload: {},
        } satisfies RuntimeEventEnvelope
        await waitForAbort(signal)
      },
    } as unknown as RuntimeServiceClient
    const session = new RuntimeClientSession(client, 'session-c')
    let sawDisconnect = false
    const connectionChanges: boolean[] = []
    session.subscribe({
      onConnectionChange: (connected) => {
        connectionChanges.push(connected)
        if (!connected) {
          sawDisconnect = true
          resolveDisconnected()
        } else if (sawDisconnect) resolveReconnected()
      },
      onEvent: (event) => {
        if (event.type === 'agent_start') resolveRecoveredEvent()
      },
    })
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await session.start()
      await initialStream
      online = false
      releaseInitialStream()
      await disconnected
      recoveryTimer = setTimeout(() => { online = true }, 2_500)
      await Promise.all([reconnected, recoveredEvent])

      expect(streamCalls).toBeGreaterThanOrEqual(3)
      expect(snapshotCalls).toBeGreaterThanOrEqual(3)
      expect(connectionChanges.filter((connected) => !connected)).toHaveLength(1)
      expect(session.isConnected).toBe(true)
    } finally {
      if (recoveryTimer) clearTimeout(recoveryTimer)
      await session.close()
    }
  })
})

import { describe, expect, test } from 'bun:test'
import {
  RuntimeServiceClient,
  RuntimeServiceClientError,
  RuntimeSnapshotRequiredError,
  RUNTIME_SERVICE_PROTOCOL_VERSION,
  createRuntimeServiceServer,
  runtimeInstanceKey,
} from '../../src/daemon/runtime-service/index.ts'

const TOKEN = 'runtime-service-secret-token-1234'

function startServer(options: { maxEventsPerSession?: number } = {}) {
  const counts = new Map<string, number>([['session-1', 0]])
  let dispatchCount = 0
  const server = createRuntimeServiceServer({
    token: TOKEN,
    hostname: '127.0.0.1',
    port: 0,
    maxEventsPerSession: options.maxEventsPerSession,
    getSnapshot: (sessionId) => counts.has(sessionId) ? { id: sessionId, count: counts.get(sessionId) } : undefined,
    dispatch: async (command, publish) => {
      dispatchCount += 1
      const count = (counts.get(command.session_id) ?? 0) + 1
      counts.set(command.session_id, count)
      publish('command.completed', { request_id: command.request_id, count })
      return { count }
    },
  })
  const client = new RuntimeServiceClient(`http://127.0.0.1:${server.port}`, TOKEN)
  return { server, client, counts, getDispatchCount: () => dispatchCount }
}

describe('Bun runtime service transport', () => {
  test('derives stable project-scoped daemon keys and accepts authenticated shutdown', async () => {
    expect(runtimeInstanceKey('C:/workspace/project')).toBe(runtimeInstanceKey('C:/workspace/project'))
    expect(runtimeInstanceKey('C:/workspace/project')).not.toBe(runtimeInstanceKey('C:/workspace/project', 'session-2'))
    let shutdownCount = 0
    const server = createRuntimeServiceServer({
      token: TOKEN,
      hostname: '127.0.0.1',
      port: 0,
      getSnapshot: () => ({ id: 'session-1' }),
      dispatch: () => undefined,
      onShutdown: () => { shutdownCount += 1 },
    })
    const client = new RuntimeServiceClient(`http://127.0.0.1:${server.port}`, TOKEN)
    try {
      await client.shutdown()
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(shutdownCount).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test('binds only loopback and requires an independent bearer token', async () => {
    expect(() => createRuntimeServiceServer({
      token: TOKEN,
      hostname: '0.0.0.0',
      getSnapshot: () => ({}),
      dispatch: () => undefined,
    })).toThrow('only bind')

    const { server } = startServer()
    try {
      const health = await fetch(`http://127.0.0.1:${server.port}/runtime/v1/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true, protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION })

      const unauthorized = await fetch(`http://127.0.0.1:${server.port}/runtime/v1/handshake`)
      expect(unauthorized.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test('handshakes, returns snapshots, and deduplicates repeated commands by request ID', async () => {
    const { server, client, getDispatchCount } = startServer()
    try {
      expect(await client.handshake()).toEqual({ protocolVersion: RUNTIME_SERVICE_PROTOCOL_VERSION })
      expect(await client.getSnapshot('session-1')).toEqual({ id: 'session-1', count: 0 })

      const first = await client.sendCommand('session-1', 'prompt', { input: 'hello' }, 'request-1')
      const duplicate = await client.sendCommand('session-1', 'prompt', { input: 'different body' }, 'request-1')
      expect(first).toEqual({ count: 1 })
      expect(duplicate).toEqual(first)
      expect(getDispatchCount()).toBe(1)
      expect(await client.getSnapshot('session-1')).toEqual({ id: 'session-1', count: 1 })
    } finally {
      await server.stop()
    }
  })

  test('rejects incompatible protocol and unknown sessions before dispatch', async () => {
    const { server, client, getDispatchCount } = startServer()
    try {
      await expect(client.getSnapshot('missing-session')).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
      const response = await fetch(`http://127.0.0.1:${server.port}/runtime/v1/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol_version: 99,
          request_id: 'request-bad-version',
          session_id: 'session-1',
          command: { type: 'abort', payload: {} },
        }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'protocol_mismatch' } })
      expect(getDispatchCount()).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test('replays ordered events and requests a snapshot when the replay window expired', async () => {
    const { server, client } = startServer({ maxEventsPerSession: 2 })
    try {
      server.publish('session-1', 'state.changed', { value: 1 })
      server.publish('session-1', 'state.changed', { value: 2 })
      server.publish('session-1', 'state.changed', { value: 3 })

      await expect(client.events('session-1', 0).next()).rejects.toBeInstanceOf(RuntimeSnapshotRequiredError)

      let streamOpened = false
      const iterator = client.events('session-1', 1, undefined, () => { streamOpened = true })
      const first = await iterator.next()
      expect(streamOpened).toBe(true)
      const second = await iterator.next()
      expect(first.value?.sequence).toBe(2)
      expect(second.value?.sequence).toBe(3)
      const nextEvent = iterator.next()
      server.publish('session-1', 'state.changed', { value: 4 })
      expect((await nextEvent).value?.sequence).toBe(4)
      await iterator.return(undefined)
    } finally {
      await server.stop()
    }
  })

  test('validates command IDs and request size before calling runtime code', async () => {
    const { server, getDispatchCount } = startServer()
    try {
      const malformed = await fetch(`http://127.0.0.1:${server.port}/runtime/v1/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION,
          request_id: 'contains spaces',
          session_id: 'session-1',
          command: { type: 'prompt', payload: {} },
        }),
      })
      expect(malformed.status).toBe(400)
      expect(getDispatchCount()).toBe(0)

      const tooLargeServer = createRuntimeServiceServer({
        token: TOKEN,
        hostname: '127.0.0.1',
        port: 0,
        maxRequestBytes: 10,
        getSnapshot: () => ({}),
        dispatch: () => { throw new Error('must not run') },
      })
      try {
        const tooLarge = await fetch(`http://127.0.0.1:${tooLargeServer.port}/runtime/v1/commands`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ payload: 'too large' }),
        })
        expect(tooLarge.status).toBe(413)
      } finally {
        await tooLargeServer.stop()
      }
    } finally {
      await server.stop()
    }
  })
})

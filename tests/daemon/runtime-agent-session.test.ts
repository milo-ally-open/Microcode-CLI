import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { ensureBootstrapMacro } from '../../src/macro.ts'
import { createRuntimeAgentService } from '../../src/daemon/runtime-service/agentSession.ts'
import { RuntimeServiceClient, RuntimeServiceClientError } from '../../src/daemon/runtime-service/client.ts'
import type { RuntimeEventEnvelope } from '../../src/daemon/runtime-service/types.ts'
import { PiJsonlSessionStore, piSessionTranscriptAdapter } from '../../src/kernel/pi/session.ts'
import { SessionManager } from '../../src/session/SessionManager.ts'

describe('runtime Agent session host', () => {
  test('owns a MicrocodeAgent session, streams DTO events, and resolves permission round trips', async () => {
    ensureBootstrapMacro()
    const root = mkdtempSync(join(tmpdir(), 'microcode-runtime-session-'))
    const cwd = join(root, 'workspace')
    const sessionsRoot = join(root, 'sessions')
    const tasksRoot = join(root, 'tasks')
    let activeStream: ReturnType<typeof createAssistantMessageEventStream> | undefined
    let notifyStreamCreated: () => void = () => undefined
    const streamCreated = new Promise<void>((resolve) => { notifyStreamCreated = resolve })
    mkdirSync(cwd, { recursive: true })

    const runtime = await createRuntimeAgentService({
      token: 'runtime-session-test-token-long-enough',
      port: 0,
      session: {
        cwd,
        sessionManager: new SessionManager({
          store: new PiJsonlSessionStore(sessionsRoot),
          transcript: piSessionTranscriptAdapter,
          tasksRoot,
        }),
        agentOptions: {
          modelId: 'deepseek-v4-pro',
          api: 'openai-completions',
          streamFn: () => {
            activeStream = createAssistantMessageEventStream()
            notifyStreamCreated()
            return activeStream
          },
        },
      },
    })

    const controller = new AbortController()
    let events: AsyncGenerator<RuntimeEventEnvelope> | undefined
    try {
      const client = new RuntimeServiceClient(`http://127.0.0.1:${runtime.server.port}`, 'runtime-session-test-token-long-enough')
      expect(await client.handshake()).toEqual({ protocolVersion: 1 })
      const initial = await client.getSnapshot<any>(runtime.session.sessionId)
      expect(initial.identity.id).toBe(`assistant-${runtime.session.sessionId}`)
      expect(initial.messages.some((message: any) => message.role === 'system')).toBe(true)
      expect(JSON.stringify(initial)).not.toContain('API_KEY')

      await client.sendCommand(runtime.session.sessionId, 'thinking.set', { level: 'max' })
      expect((await client.getSnapshot<any>(runtime.session.sessionId)).thinking_level).toBe('max')

      await client.sendCommand(runtime.session.sessionId, 'permission.set', { mode: 'interactive' })
      events = client.events(runtime.session.sessionId, 0, controller.signal) as any
      const modeChanged = await events.next()
      expect(modeChanged.value?.type).toBe('state_changed')
      await client.sendCommand(runtime.session.sessionId, 'prompt', { text: 'hello runtime' })
      await streamCreated
      expect(runtime.session.agent.isBusy()).toBe(true)
      await expect(client.sendCommand(runtime.session.sessionId, 'tool.set', {
        tool_id: 'read', enabled: false,
      })).rejects.toMatchObject({ code: 'agent_busy' } satisfies Partial<RuntimeServiceClientError>)

      const permission = runtime.session.agent.requestToolPermission('bash', { command: 'pwd' }, 'Run a command')
      let requested = await events.next()
      while (!requested.done && requested.value.type !== 'permission_requested') requested = await events.next()
      expect(requested.done).toBe(false)
      expect(requested.value?.type).toBe('permission_requested')
      const request = requested.value?.payload.request as { request_id: string }
      await client.sendCommand(runtime.session.sessionId, 'permission.resolve', {
        request_id: request.request_id,
        allowed: true,
      })
      expect(await permission).toBe(true)

      const model = runtime.session.agent.getCurrentModel()
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'runtime response' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 2,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 4,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      activeStream!.push({ type: 'start', partial: message } as any)
      activeStream!.push({ type: 'done', reason: 'stop', message } as any)
      await runtime.session.waitForIdle()
      const snapshot = await client.getSnapshot<any>(runtime.session.sessionId)
      expect(snapshot.messages.some((message: any) => message.role === 'user' && JSON.stringify(message).includes('hello runtime'))).toBe(true)
      expect(snapshot.messages.some((message: any) => message.role === 'assistant' && JSON.stringify(message).includes('runtime response'))).toBe(true)
      const assistantMessage = snapshot.messages.find((message: any) => message.role === 'assistant' && JSON.stringify(message).includes('runtime response'))
      expect(assistantMessage).toHaveProperty('model.provider_id', 'deepseek')
      expect(assistantMessage).toHaveProperty('model.model_id', 'deepseek-v4-pro')
      expect(assistantMessage).not.toHaveProperty('api')
      expect(assistantMessage).not.toHaveProperty('provider')
      expect(assistantMessage).not.toHaveProperty('model_id')
      expect(JSON.stringify(snapshot)).not.toContain('@earendil-works/pi-agent-core')
    } finally {
      controller.abort()
      await events?.return(undefined as never).catch(() => undefined)
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

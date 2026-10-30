import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBootstrapMacro } from '../../src/macro.ts'
import { createMicrocodeAgentRuntime } from '../../src/agent/index.ts'
import { RuntimeServiceClient } from '../../src/runtime/transportClient.ts'
import { createRuntimeAgentService } from '../../src/daemon/runtime-service/agentSession.ts'
import { PiJsonlSessionStore, piSessionTranscriptAdapter } from '../../src/kernel/pi/session.ts'
import { SessionManager } from '../../src/session/SessionManager.ts'

function createManager(sessionsRoot: string, tasksRoot: string) {
  return new SessionManager({
    store: new PiJsonlSessionStore(sessionsRoot),
    transcript: piSessionTranscriptAdapter,
    tasksRoot,
  })
}

describe('runtime and in-process JSONL session compatibility', () => {
  test('both default service and --no-daemon runtime paths restore the same JSONL transcript', async () => {
    ensureBootstrapMacro()
    const root = mkdtempSync(join(tmpdir(), 'microcode-cross-path-session-'))
    const cwd = join(root, 'workspace')
    const sessionsRoot = join(root, 'sessions')
    const tasksRoot = join(root, 'tasks')
    const seedManager = createManager(sessionsRoot, tasksRoot)
    await seedManager.create(cwd)
    const sessionId = seedManager.getSessionId()!
    await seedManager.saveMessages([
      { role: 'user', content: 'A request from the shared transcript.', timestamp: 1738559107000 },
      {
        role: 'assistant', content: [{ type: 'text', text: 'A response from the shared transcript.' }],
        api: 'openai-completions', provider: 'deepseek', model: 'deepseek-v4-pro',
        usage: {
          input: 4, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop', timestamp: 1738559108000,
      },
    ] as any)
    await seedManager.close()

    const options = {
      modelId: 'deepseek-v4-pro',
      api: 'openai-completions',
      streamFn: async function* () {},
    }
    let runtime: Awaited<ReturnType<typeof createRuntimeAgentService>> | undefined
    let localManager: ReturnType<typeof createManager> | undefined
    try {
      runtime = await createRuntimeAgentService({
        token: 'cross-path-runtime-test-token-long-enough',
        hostname: '127.0.0.1',
        port: 0,
        session: {
          cwd,
          resumeSessionId: sessionId,
          sessionManager: createManager(sessionsRoot, tasksRoot),
          agentOptions: options,
        },
      })

      const client = new RuntimeServiceClient(
        `http://127.0.0.1:${runtime.server.port}`,
        'cross-path-runtime-test-token-long-enough',
      )
      await client.handshake()
      const remote = await client.getSnapshot<any>(runtime.session.sessionId)
      const remoteTranscript = remote.messages.filter((message: { role: string }) => message.role !== 'system')
      expect(remote.session.id).toBe(sessionId)
      expect(remoteTranscript.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant'])
      expect(remoteTranscript[0].content).toBe('A request from the shared transcript.')
      expect(remoteTranscript[1].content[0].text).toBe('A response from the shared transcript.')
      await runtime.close()
      runtime = undefined

      localManager = createManager(sessionsRoot, tasksRoot)
      const localMetadata = (await localManager.list(cwd)).find((session) => session.id === sessionId)
      expect(localMetadata).toBeDefined()
      const localMessages = await localManager.open(localMetadata!)
      const localAgent = createMicrocodeAgentRuntime({
        cwd,
        ...options,
        persistence: localManager,
        identity: { id: `assistant-${sessionId}`, name: 'Microcode', role: 'assistant' },
      })
      localAgent.replaceMessages(localMessages, 'rebuild')
      const localTranscript = localAgent.getMessages().filter((message) => message.role !== 'system')
      expect(localTranscript.map((message) => message.role)).toEqual(['user', 'assistant'])
      expect(localTranscript[0]?.content).toBe('A request from the shared transcript.')
      expect(localTranscript[1]?.content).toMatchObject([{ type: 'text', text: 'A response from the shared transcript.' }])
      expect(readFileSync((await localManager.getMetadata())!.path, 'utf8')).toContain('A request from the shared transcript.')
    } finally {
      await runtime?.close()
      await localManager?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

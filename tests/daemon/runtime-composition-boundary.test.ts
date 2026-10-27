import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

describe('RuntimeAgentSession Pi composition boundary', () => {
  test('keeps Pi construction in the daemon composition while runtime contracts and Agent core stay neutral', async () => {
    const paths = [
      new URL('../../src/agent/MicrocodeAgent.ts', import.meta.url),
      new URL('../../src/agent/types.ts', import.meta.url),
      new URL('../../src/runtime/contracts.ts', import.meta.url),
      new URL('../../src/daemon/runtime-service/agentSession.ts', import.meta.url),
    ]
    const [agentCore, agentTypes, runtimeContracts, runtimeSession] = await Promise.all(paths.map((path) => readFile(path, 'utf8')))
    const neutralLayers = `${agentCore}\n${agentTypes}\n${runtimeContracts}`

    expect(neutralLayers).not.toMatch(/@earendil-works\/pi-(?:agent-core|ai)/)
    expect(neutralLayers).not.toMatch(/kernel\/pi/)
    expect(runtimeSession).toContain('createMicrocodeAgentRuntime')
    expect(runtimeSession).toContain('PiJsonlSessionStore')
    expect(runtimeSession).toContain('piSessionTranscriptAdapter')
    expect(runtimeSession).toContain('toRuntimeMessage')
  })
})

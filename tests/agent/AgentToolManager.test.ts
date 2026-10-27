import { describe, expect, test } from 'bun:test'
import { Type } from 'typebox'
import type { ToolAdapter } from '../../src/tools/contracts.ts'
import { getAllModels } from '../../src/models/index.ts'
import { AgentToolManager } from '../../src/agent/AgentToolManager.ts'
import { createMicrocodeAgentRuntime } from '../../src/agent/index.ts'
import { resolveAgentModelConfig } from '../../src/models/agentResolver.ts'
import { ensureBootstrapMacro } from '../../src/macro.ts'

function createManager(): AgentToolManager {
  const model = getAllModels().find((candidate) => candidate.provider === 'deepseek')!
  return new AgentToolManager({
    cwd: process.cwd(),
    getSkills: () => [],
    modelSupportsImages: model.input.includes('image'),
  })
}

function stubTool(name: string): ToolAdapter<any, any> {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }], details: undefined }
    },
  }
}

describe('AgentToolManager runtime registry', () => {
  test('starts with the basic set and applies optional tool changes atomically at the boundary', async () => {
    const manager = createManager()
    const initial = manager.getSnapshot()
    expect(initial.active).toContain('read')
    expect(initial.active).toContain('tool_control')
    expect(initial.active).not.toContain('WebSearch')
    expect(initial.disabled).toContain('WebSearch')
    expect(initial.registry.find((tool) => tool.id === 'WebSearch')).toEqual({
      id: 'WebSearch', version: 1, mutable: true,
    })

    const control = manager.getTools().find((tool) => tool.name === 'tool_control')!
    await control.execute('control', { operation: 'enable', tool_id: 'WebSearch' })
    expect(manager.getSnapshot().active).not.toContain('WebSearch')

    const committed = manager.commitPendingChanges()
    expect(committed.changed).toBe(true)
    expect(manager.getSnapshot().active).toContain('WebSearch')
    expect(manager.getSnapshot().version).toBe(initial.version + 1)

    manager.requestToolChange('WebSearch', false)
    manager.commitPendingChanges()
    expect(manager.getSnapshot().active).not.toContain('WebSearch')
    expect(manager.getSnapshot().version).toBe(initial.version + 2)
  })

  test('rejects unknown and protected IDs without changing the active snapshot', () => {
    const manager = createManager()
    const initial = manager.getSnapshot()

    expect(() => manager.requestToolChange('not_registered', true)).toThrow('not registered')
    expect(() => manager.requestToolChange('tool_control', false)).toThrow('protected')
    expect(manager.getSnapshot()).toEqual(initial)
  })

  test('registers external tools atomically and respects immutable declarations', () => {
    const manager = createManager()
    const before = manager.getSnapshot()
    expect(() => manager.addTools([
      stubTool('example_external'),
      stubTool('example_external'),
    ], { enabled: false })).toThrow('duplicated')
    expect(manager.getSnapshot().registered).not.toContain('example_external')

    const fixedTool = stubTool('example_fixed')
    manager.addTools([fixedTool], { enabled: false, mutable: false, version: 3 })
    expect(manager.getSnapshot().active).not.toContain('example_fixed')
    expect(manager.getSnapshot().registered).toContain('example_fixed')
    expect(manager.getSnapshot().disabled).toContain('example_fixed')
    expect(manager.getSnapshot().registry.find((tool) => tool.id === 'example_fixed')?.version).toBe(3)
    expect(manager.getSnapshot().version).toBe(before.version + 1)
    expect(() => manager.requestToolChange('example_fixed', true)).toThrow('cannot be changed')
  })

  test('enabling a tool does not grant or rewrite its permission', async () => {
    ensureBootstrapMacro()
    const initialModelConfig = resolveAgentModelConfig('deepseek-v4-pro', 'openai-completions')
    const agent = createMicrocodeAgentRuntime({
      initialModelConfig,
      permission: { mode: 'auto-approve', deny: ['WebSearch'] },
      streamFn: async function* () {},
    })
    const permissionBefore = agent.getPermissionSnapshot()

    await agent.setToolEnabled('WebSearch', true, agent.getToolSnapshot().version)

    expect(agent.getToolSnapshot().active).toContain('WebSearch')
    expect(agent.checkPermission('WebSearch', { query: 'example' }).allowed).toBe(false)
    expect(agent.getPermissionSnapshot()).toEqual(permissionBefore)
  })
})

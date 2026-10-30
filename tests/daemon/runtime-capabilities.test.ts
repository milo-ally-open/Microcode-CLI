import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeAgentService } from '../../src/daemon/runtime-service/agentSession.ts'
import { RuntimeClientSession } from '../../src/runtime/client.ts'
import { RuntimeServiceClient } from '../../src/runtime/transportClient.ts'
import { PiJsonlSessionStore, piSessionTranscriptAdapter } from '../../src/kernel/pi/session.ts'
import { SessionManager } from '../../src/session/SessionManager.ts'
import { ensureBootstrapMacro } from '../../src/macro.ts'
import { PluginManager } from '../../src/plugins/PluginManager.ts'
import { McpClientManager } from '../../src/mcp/client.ts'
import type { McpServerState } from '../../src/mcp/types.ts'
import { RuntimeAgentFacade } from '../../src/tui/runtimeAgentFacade.ts'
import { RuntimeTuiMcpPort } from '../../src/tui/runtimeMcpFacade.ts'
import { RuntimeTuiPluginFacade } from '../../src/tui/runtimePluginFacade.ts'

describe('runtime capability ownership and scope contract', () => {
  test('plugin scope changes update the runtime snapshot and TUI, preserving permissions and redacting package secrets', async () => {
    ensureBootstrapMacro()
    const root = await mkdtemp(join(tmpdir(), 'microcode-runtime-capabilities-'))
    const cwd = join(root, 'project')
    const pluginRoot = join(cwd, '.microcode', 'plugins', 'sample-plugin')
    const sessionsRoot = join(root, 'sessions')
    const tasksRoot = join(root, 'tasks')
    const userConfigPath = join(root, 'user-config.json')
    await mkdir(join(pluginRoot, 'skills', 'reviewer'), { recursive: true })
    await writeFile(join(pluginRoot, 'plugin.json'), JSON.stringify({
      name: 'sample-plugin',
      version: '1.0.0',
      description: 'Scope fixture',
    }))
    await writeFile(join(pluginRoot, 'skills', 'reviewer', 'SKILL.md'), [
      '---', 'name: reviewer', 'description: Review code', '---', 'Review the changed files.',
    ].join('\n'))
    await writeFile(join(pluginRoot, 'mcp.json'), JSON.stringify({
      mcpServers: {
        helper: {
          type: 'stdio',
          command: 'node',
          args: ['server.js', '--api-key', 'runtime-package-secret'],
          env: { API_TOKEN: 'runtime-env-secret' },
        },
      },
    }))

    let runtime: Awaited<ReturnType<typeof createRuntimeAgentService>> | undefined
    let clientSession: RuntimeClientSession | undefined
    try {
      const pluginManager = await PluginManager.create(cwd, '0.1.0', {
        userPluginsDir: join(root, 'user-plugins'),
        userConfigPath,
        projectConfigPath: join(cwd, '.microcode', 'config.json'),
      })
      runtime = await createRuntimeAgentService({
        token: 'runtime-capability-test-token-long-enough',
        hostname: '127.0.0.1',
        port: 0,
        session: {
          cwd,
          sessionManager: new SessionManager({
            store: new PiJsonlSessionStore(sessionsRoot),
            transcript: piSessionTranscriptAdapter,
            tasksRoot,
          }),
          pluginManager,
          agentOptions: {
            modelId: 'deepseek-v4-pro',
            api: 'openai-completions',
            streamFn: async function* () {},
            pluginSkills: [...pluginManager.getSnapshot().skills],
          },
        },
      })
      const client = new RuntimeServiceClient(
        `http://127.0.0.1:${runtime.server.port}`,
        'runtime-capability-test-token-long-enough',
      )
      clientSession = new RuntimeClientSession(client, runtime.session.sessionId)
      await clientSession.start()
      const agent = new RuntimeAgentFacade(clientSession)
      const plugins = new RuntimeTuiPluginFacade(clientSession)
      await plugins.refresh()
      const initialPermission = runtime.session.agent.getPermissionSnapshot()
      expect(plugins.findPlugin('sample-plugin')).toMatchObject({ scope: 'project', enabled: false })

      let observedPluginEnabled = false
      const changed = new Promise<void>((resolve) => {
        agent.subscribe((event) => {
          if (event.type === 'capabilities_changed'
            && agent.getRuntimeCapabilities()?.plugins.some((plugin) => plugin.name === 'sample-plugin' && plugin.enabled)) {
            observedPluginEnabled = true
            resolve()
          }
        })
      })

      await expect(plugins.setEnabledMany('user', new Map([['sample-plugin', true]]))).rejects.toThrow()
      expect(plugins.findPlugin('sample-plugin')?.enabled).toBe(false)

      const updated = await plugins.setEnabledMany('project', new Map([['sample-plugin', true]]))
      await changed
      expect(observedPluginEnabled).toBe(true)
      expect(updated.plugins[0]).toMatchObject({ scope: 'project', enabled: true, skillCount: 1 })
      expect(clientSession.snapshot?.skills.available.some((skill) => skill.plugin_id === 'sample-plugin')).toBe(true)

      const loadedSkill = await clientSession.sendCommand<{ loaded: boolean }>('skill.set', {
        skill_id: 'sample-plugin:reviewer',
        enabled: true,
      })
      expect(loadedSkill.loaded).toBe(true)
      expect(runtime.session.agent.isSkillLoaded('sample-plugin:reviewer')).toBe(true)
      const unloadedSkill = await clientSession.sendCommand<{ loaded: boolean }>('skill.set', {
        skill_id: 'sample-plugin:reviewer',
        enabled: false,
      })
      expect(unloadedSkill.loaded).toBe(false)
      expect(runtime.session.agent.isSkillLoaded('sample-plugin:reviewer')).toBe(false)
      expect(runtime.session.agent.getPermissionSnapshot()).toEqual(initialPermission)
      expect(JSON.stringify(clientSession.snapshot?.capabilities)).not.toContain('runtime-package-secret')
      expect(JSON.stringify(clientSession.snapshot?.capabilities)).not.toContain('runtime-env-secret')

      const refreshed = await plugins.refresh()
      expect(refreshed.plugins[0]).toMatchObject({ scope: 'project', enabled: true })
      expect(JSON.stringify(refreshed)).not.toContain('runtime-package-secret')
      expect(JSON.stringify(refreshed)).not.toContain('runtime-env-secret')
    } finally {
      await clientSession?.close()
      await runtime?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('MCP refresh updates runtime and TUI state without exposing configured credentials or relaxing deny rules', async () => {
    ensureBootstrapMacro()
    const root = await mkdtemp(join(tmpdir(), 'microcode-runtime-mcp-'))
    const cwd = join(root, 'project')
    const configDir = join(cwd, '.microcode')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({
      mcpServers: {
        standalone: {
          type: 'http',
          url: 'http://127.0.0.1:9/mcp',
          headers: { Authorization: 'Bearer runtime-mcp-secret' },
        },
      },
    }))

    const mcpClient = new McpClientManager()
    const states: McpServerState[] = []
    mcpClient.getAllTools = () => [{
      serverName: 'standalone',
      name: 'dangerous',
      description: 'A denied fixture tool',
      inputSchema: { type: 'object' },
    }]
    mcpClient.getServerStates = () => states
    mcpClient.getServer = (name) => states.find((state) => state.name === name)
    mcpClient.connectServer = async (name, serverConfig) => {
      states.splice(0, states.length, { name, config: serverConfig, status: 'failed', tools: [], resources: [], error: 'connection refused' })
    }
    mcpClient.removeServer = async (name) => {
      const index = states.findIndex((state) => state.name === name)
      if (index >= 0) states.splice(index, 1)
    }

    let runtime: Awaited<ReturnType<typeof createRuntimeAgentService>> | undefined
    let clientSession: RuntimeClientSession | undefined
    let agent: RuntimeAgentFacade | undefined
    try {
      runtime = await createRuntimeAgentService({
        token: 'runtime-mcp-test-token-long-enough',
        hostname: '127.0.0.1',
        port: 0,
        session: {
          cwd,
          sessionManager: new SessionManager({
            store: new PiJsonlSessionStore(join(root, 'sessions')),
            transcript: piSessionTranscriptAdapter,
            tasksRoot: join(root, 'tasks'),
          }),
          mcpClient,
          permission: { mode: 'auto-approve', deny: ['mcp__standalone__dangerous'] },
          agentOptions: {
            modelId: 'deepseek-v4-pro',
            api: 'openai-completions',
            streamFn: async function* () {},
          },
        },
      })
      clientSession = new RuntimeClientSession(
        new RuntimeServiceClient(`http://127.0.0.1:${runtime.server.port}`, 'runtime-mcp-test-token-long-enough'),
        runtime.session.sessionId,
      )
      await clientSession.start()
      agent = new RuntimeAgentFacade(clientSession)
      const mcp = new RuntimeTuiMcpPort(clientSession, agent)
      const permissionBefore = runtime.session.agent.getPermissionSnapshot()
      expect(runtime.session.agent.checkPermission('mcp__standalone__dangerous', {}).allowed).toBe(false)

      const snapshot = await mcp.refresh()
      expect(snapshot.servers).toMatchObject([{ name: 'standalone', status: 'failed', summary: expect.any(String) }])
      expect(JSON.stringify(snapshot.servers[0]?.summary).includes('runtime-mcp-secret')).toBe(false)
      expect(snapshot.configuredServers).toMatchObject([{
        name: 'standalone',
        scope: 'legacy',
        sourcePath: join(configDir, 'config.json'),
      }])
      expect(JSON.stringify(snapshot.configuredServers)).not.toContain('runtime-mcp-secret')
      expect(JSON.stringify(clientSession.snapshot?.capabilities)).not.toContain('runtime-mcp-secret')
      expect(runtime.session.agent.checkPermission('mcp__standalone__dangerous', {}).allowed).toBe(false)
      expect(runtime.session.agent.getPermissionSnapshot()).toEqual(permissionBefore)
    } finally {
      await clientSession?.close()
      agent?.dispose()
      await runtime?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

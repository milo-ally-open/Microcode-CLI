import { createRuntimeAgentService } from './agentSession.ts'
import { readRuntimeToken, removeRuntimeMetadata, runtimeMetadataForServer, runtimeStartingMetadata, writeRuntimeMetadata } from './config.ts'
import { RUNTIME_SERVICE_PROTOCOL_VERSION } from './types.ts'
import type { PermissionMode } from '../../permissions/index.ts'
import { isRuntimeThinkingLevel } from '../../runtime/contracts.ts'
import { PluginManager } from '../../plugins/PluginManager.ts'
import { McpClientManager } from '../../mcp/client.ts'
import { discoverMcpCapabilities } from '../../mcp/capabilities.ts'
import { loadProjectInstructions } from '../../instructions/projectInstructions.ts'
import { createGitWorkTreeTool } from '../../tools/index.ts'
import { GitWorkTreeSystem } from '../../git/index.ts'
import { getModelConfigDiagnostics } from '../../models/index.ts'

declare const MACRO: { VERSION: string }

function envValue(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export async function runRuntimeDaemon(): Promise<void> {
  process.title = 'microcode-runtime'
  const key = envValue('MICROCODE_RUNTIME_KEY')
  const cwd = envValue('MICROCODE_RUNTIME_CWD')
  if (!key || !cwd) throw new Error('Runtime daemon startup configuration is incomplete.')
  const token = await readRuntimeToken(key)
  await writeRuntimeMetadata(key, runtimeStartingMetadata(cwd))
  const pluginManager = await PluginManager.create(cwd, MACRO.VERSION)
  const pluginSnapshot = pluginManager.getSnapshot()
  const projectInstructions = await loadProjectInstructions(cwd)
  const mcpClient = new McpClientManager()
  const standaloneMcp = await discoverMcpCapabilities(cwd)
  const combinedMcpConfigs = { ...standaloneMcp.configs }
  const capabilityDiagnostics = [
    ...getModelConfigDiagnostics(cwd),
    ...standaloneMcp.diagnostics,
    ...pluginSnapshot.diagnostics,
  ]
  capabilityDiagnostics.push(...pluginSnapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`)))
  for (const [name, config] of Object.entries(pluginSnapshot.mcpServers)) {
    if (Object.hasOwn(combinedMcpConfigs, name)) {
      capabilityDiagnostics.push(`Plugin MCP server "${name}" conflicts with a configured MCP server; plugin server skipped.`)
      continue
    }
    combinedMcpConfigs[name] = config
  }
  const modelId = envValue('MICROCODE_RUNTIME_MODEL_ID')
  const rawThinkingLevel = envValue('MICROCODE_RUNTIME_THINKING_LEVEL')
  const thinkingLevel = rawThinkingLevel === undefined ? undefined : isRuntimeThinkingLevel(rawThinkingLevel) ? rawThinkingLevel : undefined
  const permissionMode = envValue('MICROCODE_RUNTIME_PERMISSION_MODE') as PermissionMode | undefined
  if (rawThinkingLevel !== undefined && !thinkingLevel) {
    throw new Error('Runtime daemon thinking level is invalid.')
  }
  if (permissionMode && !['interactive', 'auto-approve', 'plan'].includes(permissionMode)) {
    throw new Error('Runtime daemon permission mode is invalid.')
  }
  const portText = envValue('MICROCODE_RUNTIME_PORT') ?? '43128'
  const port = /^\d+$/.test(portText) ? Number(portText) : Number.NaN
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Runtime daemon port is invalid.')
  // MCP connections start without blocking the runtime handshake. The initial
  // pending states are exposed in the first snapshot and refreshed on completion.
  const mcpConnections = mcpClient.connectAll(combinedMcpConfigs)

  let stopping: Promise<void> | undefined
  let runtime: Awaited<ReturnType<typeof createRuntimeAgentService>> | undefined
  const removeMetadata = () => removeRuntimeMetadata(key, process.pid)
  const stop = async () => {
    if (stopping) return stopping
    stopping = (async () => {
      await runtime?.close()
      await removeMetadata()
    })()
    return stopping
  }

  try {
    runtime = await createRuntimeAgentService({
      token,
      hostname: '127.0.0.1',
      port,
      session: {
        cwd,
        ...(envValue('MICROCODE_RUNTIME_RESUME_SESSION_ID')
          ? { resumeSessionId: envValue('MICROCODE_RUNTIME_RESUME_SESSION_ID') }
          : {}),
        ...(envValue('MICROCODE_RUNTIME_RESUME_LATEST') === '1' ? { resumeLatest: true } : {}),
        agentOptions: {
          ...(modelId ? { modelId } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          projectInstructions,
          pluginSkills: [...pluginSnapshot.skills],
          pluginDiagnostics: [
            ...pluginSnapshot.diagnostics,
            ...pluginSnapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`)),
          ],
          mcpServers: mcpClient.getServerStates(),
        },
        ...(permissionMode ? { permission: { mode: permissionMode } } : {}),
        mcpClient,
        pluginManager,
        standaloneMcpConfigs: standaloneMcp.configs,
        standaloneMcpServers: standaloneMcp.servers,
        standaloneMcpDiagnostics: standaloneMcp.diagnostics,
        plugins: pluginSnapshot.plugins,
        capabilityDiagnostics,
        onSessionIdChanged: async (sessionId) => {
          if (!runtime) return
          await writeRuntimeMetadata(key, runtimeMetadataForServer(runtime.server, cwd, sessionId))
        },
      },
      onShutdown: async () => {
        await mcpClient.disconnectAll()
        await removeMetadata()
      },
    })
    runtime.session.agent.addTools([createGitWorkTreeTool(() => GitWorkTreeSystem.open(cwd))], { enabled: false })
    void mcpConnections.then(() => runtime?.session.updateMcpServers())
    const metadata = runtimeMetadataForServer(runtime.server, cwd, runtime.session.sessionId)
    if (metadata.protocolVersion !== RUNTIME_SERVICE_PROTOCOL_VERSION) throw new Error('Runtime daemon protocol version is inconsistent.')
    await writeRuntimeMetadata(key, metadata)
  } catch (error) {
    await mcpClient.disconnectAll().catch(() => undefined)
    await runtime?.close().catch(() => undefined)
    await removeRuntimeMetadata(key, process.pid)
    throw error
  }

  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
  process.once('beforeExit', () => { void removeRuntimeMetadata(key, process.pid) })
}

import type { PiMicrocodeAgent } from '../agent/index.ts'
import { discoverMcpCapabilities, safeMcpConfigSummary } from '../mcp/capabilities.ts'
import type { McpClientManager } from '../mcp/client.ts'
import type { McpServerState, ResolvedMcpServer } from '../mcp/types.ts'
import type { TuiMcpPort, TuiMcpServerState, TuiMcpSnapshot } from './mcpPort.ts'

/** Local-only adapter; MCP connections and tool installation stay in the in-process runtime. */
export class LocalTuiMcpPort implements TuiMcpPort {
  private pendingApply = false

  constructor(
    private readonly client: McpClientManager,
    private readonly agent: PiMicrocodeAgent,
    private readonly cwd: string,
  ) {}

  getReadyStates(): readonly Pick<TuiMcpServerState, 'name' | 'status'>[] {
    return this.client.getServerStates().map(({ name, status }) => ({ name, status }))
  }

  applyClientState(): void {
    if (this.agent.isBusy()) {
      this.pendingApply = true
      return
    }
    this.pendingApply = false
    this.agent.configureMcpTools(this.client)
    this.agent.updateMcpServers(this.client.getServerStates())
  }

  applyPending(): void {
    if (!this.pendingApply || this.agent.isBusy()) return
    this.applyClientState()
  }

  async refresh(): Promise<TuiMcpSnapshot> {
    const registry = await discoverMcpCapabilities(this.cwd)
    let removedStaleServer = false
    for (const state of this.client.getServerStates()) {
      const definition = registry.servers.find((server) =>
        server.name === state.name && (server.scope === 'user' || server.scope === 'project'),
      )
      if (definition && JSON.stringify(definition.config) !== JSON.stringify(state.config)) {
        await this.client.removeServer(state.name)
        removedStaleServer = true
      }
    }
    if (removedStaleServer) this.applyClientState()
    return toTuiMcpSnapshot(this.client.getServerStates(), registry.servers, registry.diagnostics)
  }
}

function toTuiMcpSnapshot(
  states: readonly McpServerState[],
  configured: readonly ResolvedMcpServer[],
  diagnostics: readonly string[],
): TuiMcpSnapshot {
  return {
    servers: states.map((state) => ({
      name: state.name,
      status: state.status,
      tools: state.tools.map((tool) => tool.name),
      resources: state.resources.map((resource) => resource.name),
      toolCount: state.tools.length,
      resourceCount: state.resources.length,
      summary: safeMcpConfigSummary(state.config),
      ...(state.error ? { error: state.error } : {}),
    })),
    configuredServers: configured.map((server) => ({
      name: server.name,
      scope: server.scope,
      ...(server.packageName ? { packageName: server.packageName } : {}),
      ...(server.sourcePath ? { sourcePath: server.sourcePath } : {}),
      summary: safeMcpConfigSummary(server.config),
    })),
    diagnostics: [...diagnostics],
  }
}

import type { RuntimeClientSession } from '../runtime/client.ts'
import type { TuiAgentPort } from './agentPort.ts'
import type { TuiMcpPort, TuiMcpSnapshot } from './mcpPort.ts'

/** MCP facade for the Chalk client; the Bun runtime owns server connections and tools. */
export class RuntimeTuiMcpPort implements TuiMcpPort {
  constructor(
    private readonly session: RuntimeClientSession,
    private readonly agent: Pick<TuiAgentPort, 'getRuntimeCapabilities'>,
  ) {}

  async refresh(): Promise<TuiMcpSnapshot> {
    await this.session.sendCommand('mcp.refresh')
    const capabilities = this.agent.getRuntimeCapabilities?.()
    if (!capabilities) throw new Error('Runtime capability snapshot is unavailable.')
    return {
      servers: capabilities.mcp_servers.map((server) => ({
        name: server.name,
        status: server.status,
        tools: [],
        resources: [],
        toolCount: server.tool_count,
        resourceCount: server.resource_count,
        summary: server.summary,
      })),
      configuredServers: [],
      diagnostics: [...capabilities.diagnostics],
    }
  }
}

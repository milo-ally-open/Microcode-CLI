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
    const result = await this.session.sendCommand<{
      configured_servers?: readonly Readonly<{
        name: string
        scope: string
        package_name?: string
        source_path?: string
        summary: string
      }>[]
    }>('mcp.refresh')
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
      configuredServers: (result.configured_servers ?? []).map((server) => ({
        name: server.name,
        scope: server.scope,
        ...(server.package_name ? { packageName: server.package_name } : {}),
        ...(server.source_path ? { sourcePath: server.source_path } : {}),
        summary: server.summary,
      })),
      diagnostics: [...capabilities.diagnostics],
    }
  }
}

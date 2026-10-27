import type { RuntimeClientSession } from '../runtime/client.ts'
import { normalizeTuiPluginHealth, normalizeTuiPluginScope, type TuiPlugin, type TuiPluginPort, type TuiPluginScope, type TuiPluginSnapshot } from './pluginPort.ts'

/** Plugin facade whose discovery and preference writes stay in the runtime. */
export class RuntimeTuiPluginFacade implements TuiPluginPort {
  constructor(private readonly session: RuntimeClientSession) {}

  getPlugins(): readonly TuiPlugin[] { return this.getSnapshot().plugins }
  getSnapshot(): TuiPluginSnapshot {
    const capabilities = this.session.snapshot?.capabilities
    const plugins = (capabilities?.plugins ?? []).map((plugin): TuiPlugin => ({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      scope: normalizeTuiPluginScope(plugin.scope),
      valid: plugin.valid,
      health: normalizeTuiPluginHealth(plugin.health),
      enabled: plugin.enabled,
      skillCount: plugin.skill_count,
      servers: plugin.servers.map((server) => ({
        pluginName: plugin.name,
        name: server.name,
        qualifiedName: server.qualified_name,
        transport: server.transport,
        safeCommandSummary: server.safe_command_summary,
        sourcePath: server.source_path,
      })),
      diagnostics: [...plugin.diagnostics],
    }))
    return { plugins, diagnostics: [...(capabilities?.diagnostics ?? [])] }
  }
  findPlugin(name: string): TuiPlugin | undefined { return this.getPlugins().find((plugin) => plugin.name === name) }
  async refresh(): Promise<TuiPluginSnapshot> {
    await this.session.sendCommand('plugin.refresh')
    return this.getSnapshot()
  }
  async setEnabledMany(scope: TuiPluginScope, desiredStates: ReadonlyMap<string, boolean>): Promise<TuiPluginSnapshot> {
    await this.session.sendCommand('plugin.set_many', { scope, states: Object.fromEntries(desiredStates) })
    return this.getSnapshot()
  }
}

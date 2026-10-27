import type { PluginManager } from '../plugins/PluginManager.ts'
import type { PluginRecord, PluginSnapshot } from '../plugins/types.ts'
import type { TuiPlugin, TuiPluginPort, TuiPluginScope, TuiPluginSnapshot } from './pluginPort.ts'

/** Maps the in-process plugin manager into the stable, UI-only contract. */
export class LocalTuiPluginAdapter implements TuiPluginPort {
  constructor(
    private readonly manager: PluginManager,
    private readonly microcodeVersion: string,
  ) {}

  getPlugins(): readonly TuiPlugin[] { return this.getSnapshot().plugins }
  getSnapshot(): TuiPluginSnapshot { return toTuiPluginSnapshot(this.manager.getSnapshot()) }
  findPlugin(name: string): TuiPlugin | undefined { return this.getPlugins().find((plugin) => plugin.name === name) }
  async refresh(): Promise<TuiPluginSnapshot> {
    return toTuiPluginSnapshot(await this.manager.refresh(this.microcodeVersion))
  }
  async setEnabledMany(scope: TuiPluginScope, desiredStates: ReadonlyMap<string, boolean>): Promise<TuiPluginSnapshot> {
    return toTuiPluginSnapshot(await this.manager.setEnabledMany(scope, desiredStates))
  }
}
export function toTuiPluginSnapshot(snapshot: PluginSnapshot): TuiPluginSnapshot {
  return {
    plugins: snapshot.plugins.map(toTuiPlugin),
    diagnostics: [...snapshot.diagnostics],
  }
}

function toTuiPlugin(plugin: PluginRecord): TuiPlugin {
  return {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    scope: plugin.scope,
    valid: plugin.valid,
    health: plugin.health,
    enabled: plugin.enabled,
    skillCount: plugin.skills.length,
    servers: plugin.servers.map((server) => ({
      pluginName: server.pluginName,
      name: server.name,
      qualifiedName: server.qualifiedName,
      transport: server.transport,
      safeCommandSummary: server.safeCommandSummary,
      sourcePath: server.sourcePath,
    })),
    diagnostics: [...plugin.diagnostics],
  }
}

export type TuiPluginScope = 'user' | 'project'
export type TuiPluginHealth = 'ready' | 'warning' | 'invalid' | 'incompatible'

export interface TuiPluginServer {
  pluginName: string
  name: string
  qualifiedName: string
  transport: string
  safeCommandSummary: string
  sourcePath: string
}

export interface TuiPlugin {
  name: string
  version: string
  description: string
  scope: TuiPluginScope
  valid: boolean
  health: TuiPluginHealth
  enabled: boolean
  skillCount: number
  servers: readonly TuiPluginServer[]
  diagnostics: readonly string[]
}

export interface TuiPluginSnapshot {
  plugins: readonly TuiPlugin[]
  diagnostics: readonly string[]
}

/** Plugin information and preference operations exposed to the TUI. */
export interface TuiPluginPort {
  getPlugins(): readonly TuiPlugin[]
  getSnapshot(): TuiPluginSnapshot
  findPlugin(name: string): TuiPlugin | undefined
  refresh(): Promise<TuiPluginSnapshot>
  setEnabledMany(scope: TuiPluginScope, desiredStates: ReadonlyMap<string, boolean>): Promise<TuiPluginSnapshot>
}

export function normalizeTuiPluginScope(scope: string): TuiPluginScope {
  return scope === 'project' ? 'project' : 'user'
}

export function normalizeTuiPluginHealth(health: string): TuiPluginHealth {
  return health === 'ready' || health === 'warning' || health === 'invalid' || health === 'incompatible'
    ? health
    : 'invalid'
}

import {
  createCodingTools,
  createToolSearchTool,
  createMcpTools,
  createListMcpResourcesTool,
  createReadMcpResourceTool,
  createToolControlTool,
  TOOL_CONTROL_TOOL_NAME,
  formatMcpInputSchema,
} from '../tools/index.ts'
import type { ToolAdapter, ToolTaskPersistence } from '../tools/contracts.ts'
import {
  getDeferredToolDefinitions,
  getToolDefinition,
  type ToolDefinition,
} from '../tools/registry.ts'
import type { Skill } from '../skill.ts'
import type { McpClientManager } from '../mcp/client.ts'
import { assertInitReadPath } from '../instructions/initReadScope.ts'

export interface AgentToolSnapshot {
  readonly version: number
  readonly active: readonly string[]
  readonly names: readonly string[]
  readonly registered: readonly string[]
  readonly mutable: readonly string[]
  readonly disabled: readonly string[]
  readonly unloaded: readonly string[]
  readonly registry: readonly Readonly<{ id: string; version: number; mutable: boolean }>[]
  readonly core: readonly string[]
  readonly infrastructure: readonly string[]
  readonly discovered: readonly string[]
  readonly external: readonly string[]
}

export class AgentToolSnapshotConflictError extends Error {
  constructor(readonly expectedVersion: number, readonly actualVersion: number) {
    super('Tool registry changed; refresh the runtime snapshot before retrying.')
    this.name = 'AgentToolSnapshotConflictError'
  }
}

type ToolMap = Map<string, ToolAdapter<any, any>>
const READ_ONLY_PROMPT_TOOL_NAMES = new Set(['read'])
const DEFAULT_ENABLED_TOOL_NAMES = new Set([
  'read', 'write', 'edit', 'bash', 'grep', 'glob', 'Ask', 'skill', 'search',
  TOOL_CONTROL_TOOL_NAME,
])
const PROTECTED_TOOL_NAMES = new Set([TOOL_CONTROL_TOOL_NAME])

function toToolMap(tools: readonly ToolAdapter<any, any>[]): ToolMap {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

function freezeNames(tools: ToolMap): readonly string[] {
  return Object.freeze([...tools.keys()])
}

export class AgentToolManager {
  private coreTools: ToolMap
  private readonly infrastructureTools: ToolMap
  private readonly discoveredTools: ToolMap = new Map()
  private readonly externalTools: ToolMap = new Map()
  private readonly pendingDiscovered = new Map<string, ToolAdapter<any, any>>()
  private readonly disabledToolNames = new Set<string>()
  private readonly externalMutableNames = new Set<string>()
  private readonly externalVersions = new Map<string, number>()
  private readonly pendingToolChanges = new Map<string, boolean>()
  private snapshotVersion = 1
  private readonly deferredDefinitions = new Map<string, ToolDefinition>(
    getDeferredToolDefinitions().map((definition) => [definition.name, definition]),
  )
  private readonly mcpToolNames = new Set<string>()
  private readonly mcpResourceToolNames = new Set<string>()
  private promptToolAllowlist?: ReadonlySet<string>

  constructor(private readonly options: {
    cwd: string
    getSkills: () => readonly Skill[]
    modelSupportsImages: boolean
    getPersistence?: () => ToolTaskPersistence | undefined
  }) {
    this.coreTools = toToolMap(this.createCoreTools(options.modelSupportsImages))
    for (const name of this.coreTools.keys()) {
      if (!DEFAULT_ENABLED_TOOL_NAMES.has(name)) this.disabledToolNames.add(name)
    }
    for (const name of this.deferredDefinitions.keys()) this.disabledToolNames.add(name)
    const searchTool = createToolSearchTool({
      getDeferredTools: () => [...this.deferredDefinitions.values()],
      onToolsDiscovered: (names) => this.queueDiscoveredTools(names),
    })
    const toolControl = createToolControlTool({
      getSnapshot: () => this.getSnapshot(),
      requestChange: (name, enabled) => this.requestToolChange(name, enabled),
    })
    this.infrastructureTools = toToolMap([searchTool, toolControl])
  }

  previewCoreTools(modelSupportsImages: boolean): ToolAdapter<any, any>[] {
    return this.createCoreTools(modelSupportsImages)
  }

  getCoreTools(): ToolAdapter<any, any>[] {
    return [...this.coreTools.values()]
  }

  replaceCoreTools(tools: readonly ToolAdapter<any, any>[]): void {
    const previousNames = [...this.coreTools.keys()].sort().join('\0')
    this.coreTools = toToolMap(tools)
    for (const name of this.coreTools.keys()) {
      if (!DEFAULT_ENABLED_TOOL_NAMES.has(name)) this.disabledToolNames.add(name)
    }
    if (previousNames !== [...this.coreTools.keys()].sort().join('\0')) this.snapshotVersion += 1
  }

  rebuildCoreTools(modelSupportsImages: boolean): void {
    this.replaceCoreTools(this.createCoreTools(modelSupportsImages))
  }

  addTools(
    tools: readonly ToolAdapter<any, any>[],
    options: { enabled?: boolean; mutable?: boolean; version?: number } = {},
  ): void {
    const version = options.version ?? 1
    if (!Number.isInteger(version) || version < 1) {
      throw new Error('External tool contract version must be a positive integer')
    }
    const requestedNames = new Set<string>()
    for (const tool of tools) {
      if (requestedNames.has(tool.name)) throw new Error(`Tool ID "${tool.name}" is duplicated in this registration`)
      requestedNames.add(tool.name)
      if (getToolDefinition(tool.name) || this.coreTools.has(tool.name) || this.infrastructureTools.has(tool.name) || this.discoveredTools.has(tool.name) || this.externalTools.has(tool.name)) {
        throw new Error(`Tool ID "${tool.name}" is already registered`)
      }
    }
    for (const tool of tools) {
      this.externalTools.set(tool.name, tool)
      this.externalVersions.set(tool.name, version)
      const mutable = options.mutable ?? true
      if (mutable) this.externalMutableNames.add(tool.name)
      else this.externalMutableNames.delete(tool.name)
      if (options.enabled === false) this.disabledToolNames.add(tool.name)
      else this.disabledToolNames.delete(tool.name)
    }
    if (tools.length > 0) this.snapshotVersion += 1
  }

  configureMcpTools(client: McpClientManager): void {
    const mcpTools = client.getAllTools()
    const nextNames = new Set(mcpTools.map((tool) => `mcp__${tool.serverName}__${tool.name}`))
    if (nextNames.size !== mcpTools.length) throw new Error('MCP tool registry contains duplicate IDs')
    const nextTools = createMcpTools(client)
    for (const tool of nextTools) {
      const isCurrentMcpTool = this.mcpToolNames.has(tool.name)
      if (!isCurrentMcpTool && (
        getToolDefinition(tool.name)
        || this.coreTools.has(tool.name)
        || this.infrastructureTools.has(tool.name)
        || this.discoveredTools.has(tool.name)
        || this.externalTools.has(tool.name)
      )) {
        throw new Error(`MCP tool ID "${tool.name}" is already registered`)
      }
    }
    const listResources = createListMcpResourcesTool(client)
    const readResource = createReadMcpResourceTool(client)
    for (const tool of [listResources, readResource]) {
      if (this.externalTools.has(tool.name) && !this.mcpResourceToolNames.has(tool.name)) {
        throw new Error(`MCP resource tool ID "${tool.name}" is already registered`)
      }
    }
    for (const name of this.mcpToolNames) {
      this.discoveredTools.delete(name)
      this.pendingDiscovered.delete(name)
      if (!nextNames.has(name)) {
        this.deferredDefinitions.delete(name)
        this.externalTools.delete(name)
        this.externalMutableNames.delete(name)
        this.disabledToolNames.delete(name)
      }
    }
    const mcpToolSchemas = new Map(
      mcpTools.map((tool) => [
        `mcp__${tool.serverName}__${tool.name}`,
        formatMcpInputSchema(tool.inputSchema),
      ]),
    )
    for (const tool of nextTools) {
      this.deferredDefinitions.set(tool.name, {
        name: tool.name,
        version: 1,
        mutable: true,
        policy: { defaultPermission: 'ask' },
        agent: {
          create: () => tool,
          shouldDefer: true,
          description: tool.description,
          schema: mcpToolSchemas.get(tool.name),
        },
      })
      this.mcpToolNames.add(tool.name)
    }
    for (const name of this.mcpToolNames) {
      if (!nextNames.has(name)) this.mcpToolNames.delete(name)
    }
    this.externalTools.set(listResources.name, listResources)
    this.externalTools.set(readResource.name, readResource)
    this.mcpResourceToolNames.add(listResources.name)
    this.mcpResourceToolNames.add(readResource.name)
    this.externalMutableNames.add(listResources.name)
    this.externalMutableNames.add(readResource.name)
    this.snapshotVersion += 1
  }

  removeTools(names: readonly string[]): void {
    const protectedName = names.find((name) => PROTECTED_TOOL_NAMES.has(name))
    if (protectedName) throw new Error(`Tool ID "${protectedName}" is protected`)
    for (const name of names) {
      this.coreTools.delete(name)
      this.infrastructureTools.delete(name)
      this.discoveredTools.delete(name)
      this.externalTools.delete(name)
      this.externalMutableNames.delete(name)
      this.externalVersions.delete(name)
      this.pendingDiscovered.delete(name)
      this.deferredDefinitions.delete(name)
      this.mcpToolNames.delete(name)
      this.mcpResourceToolNames.delete(name)
      this.disabledToolNames.delete(name)
      this.pendingToolChanges.delete(name)
    }
    if (names.length > 0) this.snapshotVersion += 1
  }

  findTool(name: string): ToolAdapter<any, any> | undefined {
    return this.getTools().find((tool) => tool.name === name)
  }

  async getApprovalPreview(name: string, input: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    return this.findTool(name)?.getApprovalPreview?.(input)
  }

  getTools(): ToolAdapter<any, any>[] {
    if (this.promptToolAllowlist) {
      return [...this.coreTools.values()]
        .filter((tool) => this.promptToolAllowlist?.has(tool.name) && !this.disabledToolNames.has(tool.name))
        .map((tool) => tool.name === 'read' ? {
          ...tool,
          execute: async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
            await assertInitReadPath(this.options.cwd, params.file_path)
            return tool.execute(toolCallId, params, signal, onUpdate)
          },
        } as ToolAdapter<any, any> : tool)
    }

    const merged = new Map<string, ToolAdapter<any, any>>()
    for (const collection of [
      this.coreTools,
      this.infrastructureTools,
      this.discoveredTools,
      this.externalTools,
    ]) {
      for (const [name, tool] of collection) {
        if (!this.disabledToolNames.has(name)) merged.set(name, tool)
      }
    }
    const tools = [...merged.values()]
    return tools
  }

  setPromptReadOnly(enabled: boolean): void {
    this.promptToolAllowlist = enabled ? READ_ONLY_PROMPT_TOOL_NAMES : undefined
  }

  requestToolChange(name: string, enabled: boolean): void {
    const tool = this.findRegisteredTool(name)
    if (!tool && !this.deferredDefinitions.has(name)) throw new Error(`Tool ID "${name}" is not registered for this Agent`)
    if (PROTECTED_TOOL_NAMES.has(name)) throw new Error(`Tool ID "${name}" is protected`)
    if (!this.isMutable(name)) throw new Error(`Tool ID "${name}" cannot be changed at runtime`)
    this.pendingToolChanges.set(name, enabled)
  }

  commitPendingChanges(): { changed: boolean; discovered: ToolAdapter<any, any>[] } {
    const discovered = [...this.pendingDiscovered.values()]
    const nextDiscovered = new Map(this.discoveredTools)
    const nextDisabled = new Set(this.disabledToolNames)

    try {
      for (const tool of discovered) {
        nextDiscovered.set(tool.name, tool)
        nextDisabled.delete(tool.name)
      }
      for (const [name, enabled] of this.pendingToolChanges) {
        if (PROTECTED_TOOL_NAMES.has(name) || !this.isMutable(name)) {
          throw new Error(`Tool ID "${name}" cannot be changed at runtime`)
        }
        const registered = this.coreTools.has(name)
          || this.infrastructureTools.has(name)
          || nextDiscovered.has(name)
          || this.externalTools.has(name)
          || this.pendingDiscovered.has(name)
          || this.deferredDefinitions.has(name)
        if (!registered) throw new Error(`Tool ID "${name}" is no longer registered`)

        if (enabled && !this.coreTools.has(name) && !this.infrastructureTools.has(name) && !nextDiscovered.has(name) && !this.externalTools.has(name)) {
          const definition = this.deferredDefinitions.get(name)
          if (!definition) throw new Error(`Tool ID "${name}" is no longer available in this capability scope`)
          nextDiscovered.set(name, definition.agent.create(this.options.cwd, {
            getPersistence: this.options.getPersistence,
          }))
        }
        if (enabled) nextDisabled.delete(name)
        else nextDisabled.add(name)
      }
    } catch (error) {
      this.pendingDiscovered.clear()
      this.pendingToolChanges.clear()
      throw error
    }

    const changed = discovered.length > 0
      || [...nextDisabled].some((name) => !this.disabledToolNames.has(name))
      || [...this.disabledToolNames].some((name) => !nextDisabled.has(name))
      || [...nextDiscovered.keys()].some((name) => !this.discoveredTools.has(name))
    this.pendingDiscovered.clear()
    this.pendingToolChanges.clear()
    if (!changed) return { changed: false, discovered: [] }

    this.discoveredTools.clear()
    for (const [name, tool] of nextDiscovered) this.discoveredTools.set(name, tool)
    this.disabledToolNames.clear()
    for (const name of nextDisabled) this.disabledToolNames.add(name)
    this.snapshotVersion += 1
    return { changed: true, discovered }
  }

  getSnapshot(): Readonly<AgentToolSnapshot> {
    const allowed = this.promptToolAllowlist
    const visibleCoreTools = new Map([...this.coreTools].filter(([name]) =>
      !this.disabledToolNames.has(name) && (!allowed || allowed.has(name))))
    const emptyTools: ToolMap = new Map()
    const registered = this.getRegisteredNames()
    const mutable = registered.filter((name) => this.isMutable(name))
    const registry = registered.map((id) => Object.freeze({
      id,
      version: getToolDefinition(id)?.version ?? this.externalVersions.get(id) ?? 1,
      mutable: this.isMutable(id),
    }))
    const active = this.getTools().map((tool) => tool.name)
    return Object.freeze({
      version: this.snapshotVersion,
      active: Object.freeze(active),
      names: Object.freeze(active),
      registered: Object.freeze(registered),
      mutable: Object.freeze(mutable),
      disabled: Object.freeze(registered.filter((name) => this.disabledToolNames.has(name))),
      unloaded: Object.freeze(registered.filter((name) => !active.includes(name) && !this.disabledToolNames.has(name))),
      registry: Object.freeze(registry),
      core: freezeNames(visibleCoreTools),
      infrastructure: allowed ? freezeNames(emptyTools) : Object.freeze([...this.infrastructureTools.keys()].filter((name) => !this.disabledToolNames.has(name))),
      discovered: allowed ? freezeNames(emptyTools) : Object.freeze([...this.discoveredTools.keys()].filter((name) => !this.disabledToolNames.has(name))),
      external: allowed ? freezeNames(emptyTools) : Object.freeze([...this.externalTools.keys()].filter((name) => !this.disabledToolNames.has(name))),
    })
  }

  private queueDiscoveredTools(names: readonly string[]): void {
    for (const name of names) {
      if (this.discoveredTools.has(name) || this.pendingDiscovered.has(name)) continue
      const definition = this.deferredDefinitions.get(name)
      if (definition) {
        this.pendingDiscovered.set(name, definition.agent.create(this.options.cwd))
      }
    }
  }

  private getRegisteredNames(): string[] {
    const names = new Set<string>()
    for (const collection of [this.coreTools, this.infrastructureTools, this.discoveredTools, this.externalTools, this.pendingDiscovered]) {
      for (const name of collection.keys()) names.add(name)
    }
    for (const name of this.deferredDefinitions.keys()) names.add(name)
    return [...names].sort()
  }

  private findRegisteredTool(name: string): ToolAdapter<any, any> | undefined {
    return this.coreTools.get(name)
      ?? this.infrastructureTools.get(name)
      ?? this.discoveredTools.get(name)
      ?? this.externalTools.get(name)
      ?? this.pendingDiscovered.get(name)
  }

  private isMutable(name: string): boolean {
    if (PROTECTED_TOOL_NAMES.has(name)) return false
    if (this.externalTools.has(name)) return this.externalMutableNames.has(name)
    return getToolDefinition(name)?.mutable !== false
  }

  private createCoreTools(modelSupportsImages: boolean): ToolAdapter<any, any>[] {
    return createCodingTools({
      cwd: this.options.cwd,
      getSkills: () => [...this.options.getSkills()],
      modelSupportsImages,
      toolContext: {
        getPersistence: this.options.getPersistence,
      },
    })
  }
}

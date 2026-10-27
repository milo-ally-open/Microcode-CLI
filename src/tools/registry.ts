import type { PermissionBehavior } from '../permissions/types.ts'
import type { ToolAdapter, ToolTaskPersistence } from './contracts.ts'

// ============================================================================
// Types
// ============================================================================

export interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError: boolean
  details?: Record<string, unknown>
}

export interface ToolCreationContext {
  getPersistence?: () => ToolTaskPersistence | undefined
}

export interface ToolSummaryContext {
  input?: Record<string, unknown>
  details?: Record<string, unknown>
  result: ToolResult
  textStats: {
    chars: number
    lines: number
  }
}

export interface ToolAgentDefinition {
  create: (cwd: string, context?: ToolCreationContext) => ToolAdapter<any, any>
  /** Search/discovery metadata exposed to the Agent, not user-facing copy. */
  description?: string
  schema?: string
  shouldDefer?: boolean
  formatDescription?: (input: Record<string, unknown>) => string
  extractMatchContent?: (input: Record<string, unknown>) => string | undefined
  /** Compact summary used when handing tool results to another Agent. */
  summarizeResult?: (context: ToolSummaryContext) => string | undefined
}

export interface ToolPolicyDefinition {
  defaultPermission: PermissionBehavior
}

export interface ToolDefinition {
  /** Stable, repository-unique tool ID. `name` is also the kernel-facing tool name. */
  name: string
  /** Contract revision for this tool adapter. Increment when its input/output contract changes. */
  version?: number
  /** Whether the Agent may enable or disable this registered implementation at runtime. */
  mutable?: boolean
  agent: ToolAgentDefinition
  policy: ToolPolicyDefinition
}

// ============================================================================
// Registry
// ============================================================================

const registry = new Map<string, ToolDefinition>()

export function registerTool(
  def: ToolDefinition,
  options: { replaceExisting?: boolean } = {},
): void {
  const version = def.version ?? 1
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Tool "${def.name}" must declare a positive integer contract version`)
  }
  if (registry.has(def.name) && !options.replaceExisting) {
    throw new Error(`Tool ID "${def.name}" is already registered`)
  }
  if (dynamicDeferredTools.has(def.name)) {
    throw new Error(`Tool ID "${def.name}" is already registered as a dynamic deferred tool`)
  }
  registry.set(def.name, { ...def, version })
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return registry.get(name)
}

export function getAllToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values())
}

function formatMcpToolName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const parts = name.slice(5).split('__')
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : name
}

function countTextBlocks(result: ToolResult): { chars: number; lines: number } {
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  return {
    chars: text.length,
    lines: text ? text.split('\n').length : 0,
  }
}

export function formatToolSummary(
  name: string,
  result: ToolResult,
  input?: Record<string, unknown>,
): string {
  const textStats = countTextBlocks(result)
  const details = result.details
  const context: ToolSummaryContext = {
    input,
    details,
    result,
    textStats,
  }
  const definition = registry.get(name)
  const formatted = definition?.agent.summarizeResult?.(context)
  if (formatted) return formatted
  const formattedName = formatMcpToolName(name) ?? name
  const produced = `produced ${textStats.chars.toLocaleString()} chars` +
    (textStats.lines > 0 ? ` across ${textStats.lines.toLocaleString()} lines` : '')
  const status = result.isError ? 'failed' : 'completed'
  return `[${formattedName}] ${status} · ${produced}`
}

export function getToolDefaultPermissions(): Record<string, PermissionBehavior> {
  const result: Record<string, PermissionBehavior> = {}
  for (const [name, def] of registry) {
    result[name] = def.policy.defaultPermission
  }
  return result
}

/** Check if a tool definition should be deferred (hidden from initial context). */
export function isDeferredTool(def: ToolDefinition): boolean {
  return def.agent.shouldDefer === true
}

/** Get tool definitions that should be loaded immediately (not deferred). */
export function getCoreToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).filter(def => !isDeferredTool(def))
}

/** Get tool definitions that are deferred (discovered via ToolSearchTool). */
export function getDeferredToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).filter(isDeferredTool)
}

// ============================================================================
// Dynamic deferred tools (for MCP tools that are created at runtime)
// ============================================================================

const dynamicDeferredTools = new Map<string, ToolDefinition>()

/** Register a dynamically created tool as deferred (e.g., MCP tools). */
export function registerDynamicDeferredTool(def: ToolDefinition): void {
  if (registry.has(def.name)) {
    throw new Error(`Tool ID "${def.name}" is already registered`)
  }
  const version = def.version ?? 1
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Tool "${def.name}" must declare a positive integer contract version`)
  }
  dynamicDeferredTools.set(def.name, { ...def, version })
}

/** Remove a dynamically registered deferred tool. */
export function unregisterDynamicDeferredTool(name: string): void {
  dynamicDeferredTools.delete(name)
}

/** Get all deferred tools (registered + dynamic). */
export function getAllDeferredToolDefinitions(): ToolDefinition[] {
  const registered = getDeferredToolDefinitions()
  const dynamic = Array.from(dynamicDeferredTools.values())
  // Deduplicate by name (registered takes precedence)
  const seen = new Set(registered.map(d => d.name))
  return [...registered, ...dynamic.filter(d => !seen.has(d.name))]
}

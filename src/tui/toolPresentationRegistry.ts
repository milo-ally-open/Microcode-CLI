import type { Component } from '@earendil-works/pi-tui'
import { basename, formatBytes, preview, shortUrl } from '../utils/displayUtils.ts'
import { countLines } from '../utils/textUtils.ts'
import { FileEditToolUI } from './toolViews/FileEdit.tsx'
import { FileWriteToolUI } from './toolViews/FileWrite.tsx'
import { BashToolUI } from './toolViews/Bash.tsx'
import { FileReadToolUI } from './toolViews/FileRead.tsx'
import { GrepToolUI } from './toolViews/Grep.tsx'
import { GlobToolUI } from './toolViews/Glob.tsx'
import { WebSearchToolUI } from './toolViews/WebSearch.tsx'
import { WebFetchToolUI } from './toolViews/WebFetch.tsx'
import { VisionToolUI } from './toolViews/Vision.tsx'
import { TaskToolUI } from './toolViews/Task.tsx'
import { AskUserQuestionToolUI } from './toolViews/AskUserQuestion.tsx'
import { isAbsolute, resolve } from 'node:path'

export interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError: boolean
  details?: Record<string, unknown>
}

export interface ToolInteractionTarget {
  action: 'toggle-preview'
  rowOffset: number
  startColumn: number
  endColumn: number
  activate: () => void
}

/** UI behavior implemented by a concrete Chalk TUI tool row. */
export interface ToolUIComponent extends Component {
  setExpanded(expanded: boolean): void
  getInteractionTargets?(renderedLines: readonly string[]): ToolInteractionTarget[]
  hasToggleButton?(): boolean
  toggleExpanded?(): void
  markExecutionStarted(): void
  updateArgs?(args: Record<string, unknown>): void
  updateElapsed?(elapsedMs: number): void
  updateResult(result: ToolResult, isPartial?: boolean): void
  updateDetails?(details: Record<string, unknown>): void
}

export type ToolUIConstructor = new (toolCallId: string, args: any) => ToolUIComponent

interface ToolDisplayContext {
  input: Record<string, unknown>
  details?: Record<string, unknown>
}

export interface ToolPresentationDefinition {
  View?: ToolUIConstructor
  activity?: (context: ToolDisplayContext) => string | undefined
  detail?: (context: ToolDisplayContext) => string | undefined
  status?: (context: ToolDisplayContext) => string | undefined
  projectInput?: (cwd: string, input: Record<string, unknown>) => Record<string, unknown> | undefined
}

const presentationDefinitions: Record<string, ToolPresentationDefinition> = {
  bash: {
    View: BashToolUI,
    activity: () => 'Running a command',
    detail: ({ input }) => preview(typeof input.command === 'string' ? input.command : '', 40) || 'bash',
    status: ({ details }) => {
      if (!details) return 'Running...'
      const stdout = typeof details.stdout === 'string' ? details.stdout : ''
      const stderr = typeof details.stderr === 'string' ? details.stderr : ''
      const lines = (stdout + stderr).split('\n').filter((line) => line.length > 0).length
      return lines > 0 ? `${lines} lines` : undefined
    },
  },
  read: {
    View: FileReadToolUI,
    activity: ({ input }) => typeof input.file_path === 'string' ? `Reading ${input.file_path}` : 'Reading a file',
    detail: ({ input }) => typeof input.file_path === 'string' ? basename(input.file_path) : 'file',
    status: ({ details }) => {
      if (!details) return 'Reading...'
      const returned = typeof details.returnedLines === 'number' ? details.returnedLines : 0
      const total = typeof details.totalLines === 'number' ? details.totalLines : 0
      return total > 0 ? `${returned}/${total} lines` : `${returned} lines`
    },
  },
  edit: {
    View: FileEditToolUI,
    projectInput: (_cwd, input) => {
      const oldString = typeof input.old_string === 'string' ? input.old_string : ''
      const newString = typeof input.new_string === 'string' ? input.new_string : ''
      return {
        path: typeof input.file_path === 'string' ? input.file_path : '',
        additions: countLines(newString),
        removals: countLines(oldString),
        replacements: input.replace_all === true ? 0 : 1,
        phase: 'preparing',
      }
    },
    activity: ({ input }) => typeof input.file_path === 'string' ? `Editing ${input.file_path}` : 'Editing a file',
    detail: ({ input }) => typeof input.file_path === 'string' ? basename(input.file_path) : 'edit',
    status: ({ details }) => {
      if (!details) return 'Editing...'
      if (details.phase === 'preparing') return 'Preparing...'
      if (details.phase === 'writing') return 'Writing...'
      const additions = typeof details.additions === 'number' ? details.additions : 0
      const removals = typeof details.removals === 'number' ? details.removals : 0
      return `${additions}+ ${removals}-`
    },
  },
  write: {
    View: FileWriteToolUI,
    projectInput: (cwd, input) => {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      const content = typeof input.content === 'string' ? input.content : ''
      const path = filePath ? (isAbsolute(filePath) ? filePath : resolve(cwd, filePath)) : ''
      return {
        path: path || filePath,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        additions: countLines(content),
        removals: 0,
        preview: content,
        phase: 'preparing',
      }
    },
    activity: ({ input }) => typeof input.file_path === 'string' ? `Writing ${input.file_path}` : 'Writing a file',
    detail: ({ input }) => typeof input.file_path === 'string' ? basename(input.file_path) : 'write',
    status: ({ details }) => {
      if (!details) return 'Writing...'
      if (details.phase === 'preparing') return 'Preparing...'
      if (details.phase === 'writing') return 'Writing...'
      const bytes = typeof details.bytesWritten === 'number' ? details.bytesWritten : 0
      return bytes > 0 ? formatBytes(bytes) : 'Writing...'
    },
  },
  grep: {
    View: GrepToolUI,
    activity: ({ input }) => typeof input.pattern === 'string' ? `Searching for ${input.pattern}` : 'Searching the codebase',
    detail: ({ input }) => typeof input.pattern === 'string' ? preview(input.pattern, 30) : 'grep',
    status: ({ details }) => {
      if (!details) return 'Searching...'
      const matches = typeof details.numMatches === 'number' ? details.numMatches : 0
      const files = typeof details.numFiles === 'number' ? details.numFiles : 0
      return files > 0 ? `${matches} matches · ${files} files` : `${matches} matches`
    },
  },
  glob: {
    View: GlobToolUI,
    activity: () => 'Finding files',
    detail: ({ input }) => typeof input.pattern === 'string' ? input.pattern : 'glob',
    status: ({ details }) => !details ? 'Finding files...' : `${typeof details.numFiles === 'number' ? details.numFiles : 0} files`,
  },
  WebSearch: {
    View: WebSearchToolUI,
    activity: ({ input }) => typeof input.query === 'string' ? `Searching ${input.query}` : 'Searching the web',
    detail: ({ input }) => typeof input.query === 'string' ? preview(input.query, 42) : 'web search',
    status: ({ details }) => {
      if (!details) return 'Searching...'
      const results = Array.isArray(details.results) ? details.results.length : undefined
      return results !== undefined && results > 0 ? `${results} results` : undefined
    },
  },
  WebFetch: {
    View: WebFetchToolUI,
    activity: ({ input }) => typeof input.url === 'string' ? `Fetching ${shortUrl(input.url)}` : 'Fetching a web page',
    detail: ({ input }) => typeof input.url === 'string' ? shortUrl(input.url) : 'web fetch',
    status: ({ details }) => {
      if (!details) return 'Fetching...'
      const bytes = typeof details.bytes === 'number' ? details.bytes : 0
      const code = typeof details.code === 'number' && details.code > 0 ? String(details.code) : undefined
      const size = bytes > 0 ? formatBytes(bytes) : undefined
      return [code, size].filter(Boolean).join(' · ') || undefined
    },
  },
  vision: { View: VisionToolUI, activity: () => 'Analyzing image', status: () => 'Analyzing image...' },
  task: {
    View: TaskToolUI,
    status: ({ input }) => typeof input.action === 'string' ? `Tasks · ${input.action}` : 'Tasks...',
  },
  Ask: { View: AskUserQuestionToolUI },
  skill: { status: ({ input }) => typeof input.skill === 'string' ? `Loading: ${input.skill}` : 'Loading skill...' },
}
const presentations = new Map<string, ToolPresentationDefinition>(Object.entries(presentationDefinitions))

export type ToolLifecycleEvent =
  | { phase: 'created'; input: Record<string, unknown> }
  | { phase: 'running' }
  | { phase: 'awaiting-approval' }
  | { phase: 'input'; input: Record<string, unknown> }
  | { phase: 'presentation'; details: Record<string, unknown> }
  | { phase: 'partial'; result: ToolResult }
  | { phase: 'completed'; result: ToolResult }
  | { phase: 'failed'; result: ToolResult }
  | { phase: 'cancelled'; details?: Record<string, unknown> }

export function getToolPresentation(name: string): ToolPresentationDefinition | undefined {
  return presentations.get(name)
}

/** Register presentation code from a statically linked TUI feature module. */
export function registerToolPresentation(name: string, definition: ToolPresentationDefinition): void {
  if (!name.trim()) throw new Error('Tool presentation ID must not be empty')
  if (presentations.has(name)) throw new Error(`Tool presentation ID "${name}" is already registered`)
  presentations.set(name, Object.freeze({ ...definition }))
}

export function getToolUIConstructor(name: string): ToolUIConstructor | undefined {
  return getToolPresentation(name)?.View
}

function formatMcpToolName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const parts = name.slice(5).split('__')
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : name
}

export function formatToolActivity(name: string, input: Record<string, unknown>): string {
  return getToolPresentation(name)?.activity?.({ input }) ?? `Using ${formatMcpToolName(name) ?? name}`
}

export function formatToolDetail(name: string, input: Record<string, unknown>): string {
  return getToolPresentation(name)?.detail?.({ input }) ?? formatMcpToolName(name) ?? ''
}

export function formatToolStatus(name: string, input: Record<string, unknown>, details?: Record<string, unknown>): string | undefined {
  return getToolPresentation(name)?.status?.({ input, details })
    ?? (details ? undefined : formatMcpToolName(name))
}

/** One presentation-only boundary maps generic lifecycle events onto tool views. */
export function dispatchToolLifecycle(view: ToolUIComponent, event: ToolLifecycleEvent): void {
  switch (event.phase) {
    case 'created': view.updateArgs?.(event.input); break
    case 'running': view.markExecutionStarted(); break
    case 'awaiting-approval': view.updateDetails?.({ phase: 'approval' }); break
    case 'input': view.updateArgs?.(event.input); break
    case 'presentation': view.updateDetails?.(event.details); break
    case 'partial':
      view.updateResult(event.result, true)
      if (event.result.details) view.updateDetails?.(event.result.details)
      break
    case 'completed':
    case 'failed':
      view.updateResult(event.result)
      if (event.result.details) view.updateDetails?.(event.result.details)
      break
    case 'cancelled': view.updateDetails?.({ ...event.details, phase: 'cancelled' }); break
  }
}

export function projectToolInput(
  name: string,
  cwd: string,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return getToolPresentation(name)?.projectInput?.(cwd, input)
}

import type { Static, TSchema } from 'typebox'
import type { TaskList, TaskMarkUpdate } from '../tasks/TaskSystem.ts'

/** Stable built-in IDs shared by tool implementations and the TUI presentation layer. */
export const TOOL_IDS = {
  bash: 'bash',
  read: 'read',
  write: 'write',
  edit: 'edit',
} as const

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolExecutionResult<Details = unknown> {
  content: ToolContentBlock[]
  details: Details
}

export type ToolUpdateCallback<Details = unknown> = (partialResult: ToolExecutionResult<Details>) => void

/** Kernel-neutral executable tool. A kernel adapter turns this contract into its native tool type. */
export interface ToolAdapter<Parameters extends TSchema = TSchema, Details = unknown> {
  name: string
  label: string
  description: string
  parameters: Parameters
  prepareArguments?: (args: unknown) => Static<Parameters>
  /** Optional, read-only details for a permission prompt; the TUI receives the result as a DTO. */
  getApprovalPreview?: (input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>
  execute: (
    toolCallId: string,
    params: Static<Parameters>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback<Details>,
  ) => Promise<ToolExecutionResult<Details>>
}

/** Narrow runtime capability required by the optional session task tool. */
export interface ToolTaskPersistence {
  createTaskList?: (title: string, tasks: readonly string[]) => Promise<TaskList>
  claimTaskList?: (listId: string) => Promise<TaskList>
  markTask?: (listId: string | undefined, taskId: string, completed: boolean, pending?: boolean) => Promise<TaskList>
  markTasks?: (input: { list_id?: string; tasks: readonly TaskMarkUpdate[] }) => Promise<TaskList>
}

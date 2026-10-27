import type { RuntimeMessage } from '../runtime/contracts.ts'

export interface TuiSessionMetadata {
  id: string
  cwd: string
  createdAt: number | string
  title?: string
}

export interface TuiTaskItem {
  id: string
  content: string
  completed: boolean
  pending?: boolean
  reminder?: boolean
  createdAt: string
  updatedAt: string
}

export interface TuiTaskList {
  id: string
  title: string
  tasks: TuiTaskItem[]
  createdAt: string
  updatedAt: string
  stats?: { total: number; completed: number; inProgress: number; remaining: number }
}

/** Session operations and view data required by the TUI. */
export interface TuiSessionPort {
  getSessionId(): string | null
  getTitle(sessionId: string): string | undefined
  getMetadata(): TuiSessionMetadata | null
  listWithTitles(cwd?: string): Promise<TuiSessionMetadata[]>
  switchToSession(session: TuiSessionMetadata): Promise<RuntimeMessage[]>
  beginDraft(cwd: string): void
  ensureCreated(cwd?: string): Promise<string>
  setTitle(sessionId: string, title: string): void | Promise<void>
  listTaskLists(): Promise<TuiTaskList[]>
  remindTask(listId: string, taskId: string, reminder?: boolean): Promise<TuiTaskList>
  exportCurrent(): Promise<string | undefined>
  close(): Promise<void>
}

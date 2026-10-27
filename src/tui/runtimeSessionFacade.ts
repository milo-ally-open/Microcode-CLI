import type { RuntimeMessage } from '../runtime/contracts.ts'
import type { RuntimeClientSession } from '../runtime/client.ts'
import type { TuiAgentPort } from './agentPort.ts'
import type { TuiSessionMetadata, TuiSessionPort, TuiTaskList } from './sessionPort.ts'

/** Session facade whose persistence and task operations stay inside the runtime process. */
export class RuntimeTuiSessionPort implements TuiSessionPort {
  private readonly titles = new Map<string, string>()

  constructor(
    private readonly session: RuntimeClientSession,
    private readonly agent: Pick<TuiAgentPort, 'getMessages'>,
  ) {}

  getSessionId(): string | null { return this.session.sessionId || null }
  getTitle(sessionId: string): string | undefined {
    if (sessionId === this.session.sessionId) return this.session.snapshot?.session.title ?? this.titles.get(sessionId)
    return this.titles.get(sessionId)
  }
  getMetadata(): TuiSessionMetadata | null {
    const meta = this.session.snapshot?.session
    if (!meta) return null
    return { id: meta.id, cwd: meta.cwd, createdAt: meta.created_at, ...(meta.title ? { title: meta.title } : {}) }
  }
  async listWithTitles(cwd?: string): Promise<TuiSessionMetadata[]> {
    const entries = await this.session.sendCommand<Array<{ id: string; cwd: string; created_at: number | string; title?: string }>>('session.list', cwd ? { cwd } : {})
    return entries.map((entry) => {
      if (entry.title) this.titles.set(entry.id, entry.title)
      return { id: entry.id, cwd: entry.cwd, createdAt: entry.created_at, ...(entry.title ? { title: entry.title } : {}) }
    })
  }
  async switchToSession(target: TuiSessionMetadata): Promise<RuntimeMessage[]> {
    await this.session.sendCommand('session.open', { session_id: target.id })
    if (target.title) this.titles.set(target.id, target.title)
    return [...this.agent.getMessages()]
  }
  beginDraft(_cwd: string): void { /* session.clear creates a fresh runtime session */ }
  async ensureCreated(_cwd?: string): Promise<string> {
    const id = this.getSessionId()
    if (!id) throw new Error('Runtime session is not initialized.')
    return id
  }
  async setTitle(sessionId: string, title: string): Promise<void> {
    await this.session.sendCommand('session.title.set', { session_id: sessionId, title })
    this.titles.set(sessionId, title)
  }
  listTaskLists(): Promise<TuiTaskList[]> { return this.session.sendCommand('session.tasks.list') }
  remindTask(listId: string, taskId: string, reminder = true): Promise<TuiTaskList> {
    return this.session.sendCommand('session.tasks.remind', { list_id: listId, task_id: taskId, reminder })
  }
  async exportCurrent(): Promise<string | undefined> {
    const result = await this.session.sendCommand<{ path: string }>('session.export')
    return result.path
  }
  close(): Promise<void> { return this.session.close() }
}

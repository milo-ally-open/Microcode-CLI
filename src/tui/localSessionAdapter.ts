import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { JsonlSessionMetadata } from '@earendil-works/pi-agent-core/harness/session'
import type { SessionListItem, SessionManager } from '../session/SessionManager.ts'
import { exportSessionJsonl } from '../kernel/pi/exportSession.ts'
import { toRuntimeMessage } from '../kernel/pi/mapper.ts'
import type { TuiSessionMetadata, TuiSessionPort, TuiTaskList } from './sessionPort.ts'

/** Local adapter used by the explicitly in-process --no-daemon path. */
export class LocalTuiSessionPort implements TuiSessionPort {
  constructor(
    private readonly manager: SessionManager<AgentMessage, JsonlSessionMetadata>,
    private readonly restoreMessages?: (messages: readonly AgentMessage[]) => void | Promise<void>,
  ) {}

  getSessionId(): string | null { return this.manager.getSessionId() }
  getTitle(sessionId: string): string | undefined { return this.manager.getTitle(sessionId) }
  getMetadata(): TuiSessionMetadata | null {
    const metadata = this.manager.getMetadata()
    return metadata ? { id: metadata.id, cwd: metadata.cwd, createdAt: metadata.createdAt, title: this.manager.getTitle(metadata.id) } : null
  }
  async listWithTitles(cwd?: string): Promise<TuiSessionMetadata[]> {
    return (await this.manager.listWithTitles(cwd)).map(toTuiSessionMetadata)
  }
  async switchToSession(session: TuiSessionMetadata): Promise<import('../runtime/contracts.ts').RuntimeMessage[]> {
    const metadata = (await this.manager.list(session.cwd)).find((entry) => entry.id === session.id)
    if (!metadata) throw new Error('The requested session was not found.')
    const messages = await this.manager.switchToSession(metadata)
    await this.restoreMessages?.(messages)
    return messages.map(toRuntimeMessage)
  }
  beginDraft(cwd: string): void { this.manager.beginDraft(cwd) }
  ensureCreated(cwd?: string): Promise<string> { return this.manager.ensureCreated(cwd) }
  setTitle(sessionId: string, title: string): void { this.manager.setTitle(sessionId, title) }
  listTaskLists(): Promise<TuiTaskList[]> { return this.manager.listTaskLists() }
  remindTask(listId: string, taskId: string, reminder = true): Promise<TuiTaskList> {
    return this.manager.remindTask(listId, taskId, reminder)
  }
  async exportCurrent(): Promise<string | undefined> {
    const metadata = this.manager.getMetadata()
    if (!metadata) return undefined
    return exportSessionJsonl(metadata.path, metadata.cwd, metadata.id)
  }
  close(): Promise<void> { return this.manager.close() }
}

function toTuiSessionMetadata(session: SessionListItem<JsonlSessionMetadata>): TuiSessionMetadata {
  return {
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    ...(session.title ? { title: session.title } : {}),
  }
}

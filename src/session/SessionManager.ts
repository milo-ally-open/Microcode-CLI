import * as path from 'path'
import * as os from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type {
  AgentCompactionRecord,
  AgentSessionPersistence,
} from '../agent/persistence.ts'
import {
  TaskSystem,
  type TaskList,
  type TaskMarkUpdate,
  type TaskReminderUpdate,
} from '../tasks/TaskSystem.ts'
import type {
  RuntimeSessionMetadata,
  SessionArchiveEntry,
  SessionStore,
  SessionTranscriptAdapter,
} from './contracts.ts'

const SESSIONS_DIR = path.join(os.homedir(), '.microcode', 'sessions')
const TITLES_FILE = path.join(SESSIONS_DIR, '.titles.json')
const TASKS_DIR = path.join(SESSIONS_DIR, '.tasks')
const COMPACTION_CHECKPOINT_TYPE = 'microcode.compaction-checkpoint'

interface CompactionCheckpoint<Message> {
  version: 1
  summary: string
  contextMessages: Message[]
  tokensBefore: number
  tokensAfter: number
  keptMessageCount: number
  compactedMessageCount: number
  automatic: boolean
  model: AgentCompactionRecord<Message>['model']
}

function isCompactionCheckpoint<Message>(data: unknown): data is CompactionCheckpoint<Message> {
  if (!data || typeof data !== 'object') return false
  const checkpoint = data as Partial<CompactionCheckpoint<Message>>
  return checkpoint.version === 1 &&
    typeof checkpoint.summary === 'string' &&
    Array.isArray(checkpoint.contextMessages) &&
    typeof checkpoint.tokensBefore === 'number' &&
    typeof checkpoint.tokensAfter === 'number'
}

export type SessionListItem<Metadata extends RuntimeSessionMetadata = RuntimeSessionMetadata> = Metadata & {
  title?: string
}

/** Runtime-owned session lifecycle over injected persistence and transcript ports. */
export class SessionManager<
  Message,
  Metadata extends RuntimeSessionMetadata = RuntimeSessionMetadata,
> implements AgentSessionPersistence<Message> {
  private metadata: Metadata | null = null
  private draftCwd: string | null = null
  private createPromise: Promise<string> | null = null
  private savedMessageCount = 0
  private titleCache: Map<string, string> | null = null
  private readonly taskSystem: TaskSystem

  constructor(private readonly options: {
    store: SessionStore<Message, Metadata>
    transcript: SessionTranscriptAdapter<Message>
    tasksRoot?: string
  }) {
    this.taskSystem = new TaskSystem(options.tasksRoot ?? TASKS_DIR)
  }

  /** Create a durable session for the given working directory. */
  async create(cwd: string): Promise<string> {
    this.metadata = await this.options.store.create(cwd)
    this.draftCwd = null
    this.savedMessageCount = 0
    return this.metadata.id
  }

  /** Start a new in-memory session without writing anything to disk yet. */
  beginDraft(cwd: string): void {
    this.metadata = null
    this.draftCwd = cwd
    this.savedMessageCount = 0
  }

  /** Materialize the current draft only when durable state is needed. */
  async ensureCreated(cwd?: string): Promise<string> {
    if (this.metadata?.id) return this.metadata.id
    const targetCwd = cwd ?? this.draftCwd
    if (!targetCwd) throw new Error('No active session.')
    if (!this.createPromise) {
      this.createPromise = this.create(targetCwd).finally(() => {
        this.createPromise = null
      })
    }
    return this.createPromise
  }

  isDraft(): boolean {
    return !this.metadata && Boolean(this.draftCwd)
  }

  /** Resume an existing session from metadata. */
  async open(metadata: Metadata): Promise<Message[]> {
    await this.options.store.open(metadata)
    this.metadata = metadata
    this.draftCwd = null
    const messages = await this.readSessionMessages()
    this.savedMessageCount = messages.length
    return messages
  }

  /** List available sessions, optionally filtered by working directory. */
  list(cwd?: string): Promise<Metadata[]> {
    return this.options.store.list(cwd)
  }

  async getLatestSession(cwd: string): Promise<Metadata | null> {
    return (await this.list(cwd))[0] ?? null
  }

  /** Persist new messages, appending only messages not saved before. */
  async saveMessages(messages: readonly Message[]): Promise<void> {
    if (!this.metadata) {
      if (messages.length === 0) return
      await this.ensureCreated()
    }
    if (!this.metadata) return

    for (let i = this.savedMessageCount; i < messages.length; i++) {
      await this.options.store.appendMessage(
        this.options.transcript.replaceImagesForPersistence(messages[i]!),
      )
    }
    this.savedMessageCount = messages.length
  }

  async recordCompaction(record: AgentCompactionRecord<Message>): Promise<void> {
    if (!this.metadata) return
    const entries = await this.options.store.loadEntries()
    if (!entries.some((entry) => entry.type === 'message')) {
      throw new Error('No persisted messages available for compaction.')
    }
    const checkpoint: CompactionCheckpoint<Message> = {
      version: 1,
      summary: record.summary,
      contextMessages: record.messages.map((message) =>
        this.options.transcript.replaceImagesForPersistence(message),
      ),
      tokensBefore: record.tokensBefore,
      tokensAfter: record.tokensAfter,
      keptMessageCount: record.keptMessageCount,
      compactedMessageCount: record.compactedMessageCount,
      automatic: record.automatic,
      model: record.model,
    }
    await this.options.store.appendCustomEntry(COMPACTION_CHECKPOINT_TYPE, checkpoint)
    this.savedMessageCount = record.compactedMessageCount
  }

  async loadMessages(): Promise<Message[]> {
    if (!this.metadata) return []
    return this.readSessionMessages()
  }

  async loadArchiveEntries(): Promise<SessionArchiveEntry<Message>[]> {
    if (!this.metadata) return []
    return this.options.store.loadEntries()
  }

  getMetadata(): Metadata | null {
    return this.metadata
  }

  getSessionId(): string | null {
    return this.metadata?.id ?? null
  }

  async createTaskList(title: string, tasks: readonly string[]): Promise<TaskList> {
    return this.taskSystem.createList(await this.ensureCreated(), title, tasks)
  }

  async listTaskLists(): Promise<TaskList[]> {
    const sessionId = this.getSessionId()
    return sessionId ? this.taskSystem.listTaskLists(sessionId) : []
  }

  async getTaskReminder(): Promise<string | undefined> {
    const sessionId = this.getSessionId()
    return sessionId ? this.taskSystem.getReminder(sessionId) : undefined
  }

  async claimTaskList(listId: string): Promise<TaskList> {
    return this.taskSystem.claimTaskList(await this.ensureCreated(), listId)
  }

  async remindTask(listId: string, taskId: string, reminder = true): Promise<TaskList> {
    return this.taskSystem.remindTask(await this.ensureCreated(), listId, taskId, reminder)
  }

  async remindTasks(listId: string, tasks: readonly TaskReminderUpdate[]): Promise<TaskList> {
    return this.taskSystem.remindTasks(await this.ensureCreated(), listId, tasks)
  }

  async markTask(
    listId: string | undefined,
    taskId: string,
    completed: boolean,
    pending?: boolean,
  ): Promise<TaskList> {
    return this.taskSystem.markTask(await this.ensureCreated(), listId, taskId, completed, pending)
  }

  async markTasks(input: {
    list_id?: string
    tasks: readonly TaskMarkUpdate[]
  }): Promise<TaskList> {
    return this.taskSystem.markTasks(await this.ensureCreated(), input)
  }

  async delete(metadata: Metadata): Promise<void> {
    await this.options.store.delete(metadata)
  }

  private loadTitles(): void {
    if (this.titleCache) return
    try {
      this.titleCache = existsSync(TITLES_FILE)
        ? new Map(Object.entries(JSON.parse(readFileSync(TITLES_FILE, 'utf-8'))))
        : new Map()
    } catch {
      this.titleCache = new Map()
    }
  }

  private saveTitles(): void {
    try {
      const dir = path.dirname(TITLES_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(TITLES_FILE, JSON.stringify(Object.fromEntries(this.titleCache ?? new Map()), null, 2))
    } catch {}
  }

  setTitle(sessionId: string, title: string): void {
    this.loadTitles()
    this.titleCache!.set(sessionId, title)
    this.saveTitles()
  }

  getTitle(sessionId: string): string | undefined {
    this.loadTitles()
    return this.titleCache?.get(sessionId)
  }

  async listWithTitles(cwd?: string): Promise<SessionListItem<Metadata>[]> {
    const sessions = await this.options.store.list(cwd)
    this.loadTitles()
    return sessions.map((session) => ({ ...session, title: this.titleCache?.get(session.id) }))
  }

  /** Switch active session; the caller persists the current runtime first. */
  async switchToSession(metadata: Metadata): Promise<Message[]> {
    return this.open(metadata)
  }

  private async readSessionMessages(): Promise<Message[]> {
    const entries = await this.options.store.loadEntries()
    let messages: Message[] = []
    for (const entry of entries) {
      if (entry.type === 'message') {
        messages = [...(
          this.options.transcript.restoreLegacyCompactionContext(
            messages,
            entry.message,
            entry.timestamp,
          ) ?? [...messages, entry.message]
        )]
      } else if (entry.type === 'compaction') {
        messages = [
          this.options.transcript.createSummaryMessage(entry.summary, entry.timestamp, 'compaction'),
          ...entry.retainedTail,
        ]
      } else if (entry.type === 'branch_summary') {
        messages.push(this.options.transcript.createSummaryMessage(entry.summary, entry.timestamp, 'branch_summary'))
      } else if (
        entry.customType === COMPACTION_CHECKPOINT_TYPE &&
        isCompactionCheckpoint<Message>(entry.data)
      ) {
        messages = [...entry.data.contextMessages]
      }
    }
    return messages
  }

  close(): Promise<void> {
    return this.options.store.close()
  }
}

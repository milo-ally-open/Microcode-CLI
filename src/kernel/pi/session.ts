import { BACKGROUND_CONTEXT, type AgentMessage } from '@earendil-works/pi-agent-core'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  JsonlSessionRepo,
  type JsonValue,
  type JsonlSessionMetadata,
  type Session,
} from '@earendil-works/pi-agent-core/harness/session'
import { findModel } from '../../models/index.ts'
import type {
  SessionArchiveEntry,
  SessionStore,
  SessionTranscriptAdapter,
} from '../../session/contracts.ts'
import { getCompactUserSummaryMessage } from '../../session/compactPrompt.ts'
import { restoreLegacyPiCompactionContext } from './compaction.ts'
import { NodeFileSystem } from './nodeFileSystem.ts'

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
  model: { provider: string; modelId: string; contextWindow: number }
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

function getLegacyCompactionSummary(message: AgentMessage): { summary: string; tokensBefore: number } | undefined {
  if (message.role !== 'user' || typeof message.content !== 'string') return undefined
  const match = message.content.match(/^\[Earlier conversation summarized \((\d+) tokens before compaction\)\]:\n([\s\S]*)$/)
  if (!match) return undefined
  return { tokensBefore: Number(match[1]), summary: match[2] ?? '' }
}

export function replacePiImageBlocksForPersistence(message: AgentMessage): AgentMessage {
  if (message.role !== 'user' && message.role !== 'toolResult') return message
  if (typeof message.content === 'string') return message

  let changed = false
  const content = message.content.map((block) => {
    if (block.type !== 'image') return block
    changed = true
    return { type: 'text' as const, text: `[Image: ${(block as { mimeType?: string }).mimeType ?? 'unknown'}]` }
  })
  return changed ? { ...message, content } : message
}

/** Pi's JSONL repository and transcript compatibility live behind this kernel adapter. */
export class PiJsonlSessionStore implements SessionStore<AgentMessage, JsonlSessionMetadata> {
  private readonly repo: JsonlSessionRepo
  private session: Session<JsonlSessionMetadata> | null = null

  constructor(sessionsRoot = path.join(os.homedir(), '.microcode', 'sessions')) {
    this.repo = new JsonlSessionRepo({
      fileSystem: new NodeFileSystem('/'),
      sessionsRoot,
    })
  }

  async create(cwd: string): Promise<JsonlSessionMetadata> {
    this.session = await this.repo.create({ cwd }, BACKGROUND_CONTEXT)
    await this.ensureMainBranch(this.session)
    return this.session.metadata
  }

  async open(metadata: JsonlSessionMetadata): Promise<void> {
    this.session = await this.repo.open(metadata, BACKGROUND_CONTEXT)
    await this.ensureMainBranch(this.session)
  }

  list(cwd?: string): Promise<JsonlSessionMetadata[]> {
    return this.repo.list(cwd ? { cwd } : undefined, BACKGROUND_CONTEXT)
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    const branch = await this.requireSession().branch('main', BACKGROUND_CONTEXT)
    if (!branch) throw new Error('Session main branch is unavailable.')
    await branch.appendMessage(message, BACKGROUND_CONTEXT)
  }

  async appendCustomEntry(type: string, data: unknown): Promise<void> {
    const branch = await this.requireSession().branch('main', BACKGROUND_CONTEXT)
    if (!branch) throw new Error('Session main branch is unavailable.')
    await branch.appendCustomEntry(type, data as JsonValue, BACKGROUND_CONTEXT)
  }

  async loadEntries(): Promise<SessionArchiveEntry<AgentMessage>[]> {
    if (!this.session) return []
    const entries = await this.session.findEntries({ order: 'asc' }, BACKGROUND_CONTEXT)
    return entries.map((entry) => {
      if (entry.type === 'message') {
        return { type: 'message', message: entry.message, timestamp: entry.timestamp }
      }
      if (entry.type === 'compaction') {
        return {
          type: 'compaction',
          summary: entry.summary,
          retainedTail: entry.retainedTail,
          timestamp: entry.timestamp,
        }
      }
      if (entry.type === 'branch_summary') {
        return { type: 'branch_summary', summary: entry.summary, timestamp: entry.timestamp }
      }
      return {
        type: 'custom',
        customType: entry.customType,
        ...(entry.data === undefined ? {} : { data: entry.data }),
        timestamp: entry.timestamp,
      }
    })
  }

  delete(metadata: JsonlSessionMetadata): Promise<void> {
    return this.repo.delete(metadata, BACKGROUND_CONTEXT)
  }

  close(): Promise<void> {
    return this.repo.close(BACKGROUND_CONTEXT)
  }

  private requireSession(): Session<JsonlSessionMetadata> {
    if (!this.session) throw new Error('No active session.')
    return this.session
  }

  private async ensureMainBranch(session: Session<JsonlSessionMetadata>): Promise<void> {
    if (await session.branch('main', BACKGROUND_CONTEXT)) return
    await session.createBranch('main', null, BACKGROUND_CONTEXT)
  }
}

export const piSessionTranscriptAdapter: SessionTranscriptAdapter<AgentMessage> = {
  replaceImagesForPersistence: replacePiImageBlocksForPersistence,
  restoreLegacyCompactionContext(messages, legacyMessage, timestamp) {
    const legacy = getLegacyCompactionSummary(legacyMessage)
    if (!legacy) return undefined
    const priorAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    const model = priorAssistant?.role === 'assistant'
      ? findModel(priorAssistant.model, priorAssistant.api, String(priorAssistant.provider))
      : undefined
    return model
      ? restoreLegacyPiCompactionContext(
          messages,
          model.contextWindow,
          legacy.tokensBefore,
          legacy.summary,
          timestamp,
        )
      : undefined
  },
  createSummaryMessage(summary, timestamp, kind) {
    return {
      role: 'user',
      content: kind === 'compaction'
        ? getCompactUserSummaryMessage(summary)
        : `[Conversation summary]:\n${summary}`,
      timestamp,
    }
  },
}

import type {
  CompactionMessageAdapter,
  CompactionSummaryGenerator,
} from './contracts.ts'

export type { CompactionSummaryGenerator } from './contracts.ts'

export interface CompactionProgress {
  phase:
    | 'microcompact'
    | 'analyzing'
    | 'summarizing'
    | 'validating'
    | 'persisting'
    | 'committing'
    | 'done'
  message: string
  tokensBefore?: number
  tokensAfter?: number
  progress?: number
  elapsedMs?: number
  processedUnits?: number
  totalUnits?: number
}

export interface CompactionSettings {
  enabled: boolean
  reserveTokens: number
  keepRecentTokens: number
}

export const DEFAULT_COMPACTION_SETTINGS: Readonly<CompactionSettings> = Object.freeze({
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
})

export interface ContextCompactionResult<Message> {
  summary: string
  messages: Message[]
  tokensBefore: number
  tokensAfter: number
  keptMessageCount: number
  automatic: boolean
}

export interface ConversationUnit<Message> {
  messages: Message[]
  tokens: number
  safeToRetain: boolean
}

const CLEARED_MESSAGE = '[Old tool result content cleared]'

// Keep the last N tool results of each type.
const KEEP_RECENT_TOOLS = 3
const RECENT_CONTEXT_RATIO = 0.1
const RECENT_HISTORY_RATIO = 0.2

export function buildConversationUnits<Message>(
  messages: readonly Message[],
  adapter: CompactionMessageAdapter<Message>,
): ConversationUnit<Message>[] {
  const units: ConversationUnit<Message>[] = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!
    const toolCalls = adapter.getToolCalls(message)
    if (toolCalls.length === 0) {
      units.push({
        messages: [message],
        tokens: adapter.estimateTokens([message]),
        safeToRetain: adapter.getToolResult(message) === undefined,
      })
      index++
      continue
    }

    const unitMessages: Message[] = [message]
    const resultIds = new Set<string>()
    let cursor = index + 1
    while (cursor < messages.length) {
      const result = adapter.getToolResult(messages[cursor]!)
      if (!result) break
      unitMessages.push(messages[cursor]!)
      resultIds.add(result.callId)
      cursor++
    }
    const expectedIds = new Set(toolCalls.map((call) => call.id))
    units.push({
      messages: unitMessages,
      tokens: adapter.estimateTokens(unitMessages),
      safeToRetain:
        unitMessages.length - 1 === expectedIds.size &&
        resultIds.size === expectedIds.size &&
        [...resultIds].every((id) => expectedIds.has(id)),
    })
    index = cursor
  }
  return units
}

function normalizeSummaryMessages<Message>(
  units: readonly ConversationUnit<Message>[],
  adapter: CompactionMessageAdapter<Message>,
): Message[] {
  return units.flatMap((unit) => {
    if (unit.safeToRetain) return unit.messages
    const timestamp = adapter.getTimestamp(unit.messages[0]!) ?? Date.now()
    return [adapter.createUserMessage(
      '[Malformed tool interaction preserved as text for summarization]\n' +
        adapter.formatMalformedUnit(unit.messages),
      timestamp,
    )]
  })
}

function selectCompactionRanges<Message>(
  units: readonly ConversationUnit<Message>[],
  contextWindow: number,
  tokensBefore: number,
): { summaryUnits: ConversationUnit<Message>[]; recentUnits: ConversationUnit<Message>[] } {
  const recentBudget = Math.max(
    1,
    Math.min(
      Math.floor(contextWindow * RECENT_CONTEXT_RATIO),
      Math.floor(tokensBefore * RECENT_HISTORY_RATIO),
    ),
  )
  let recentTokens = 0
  let start = units.length
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!
    if (!unit.safeToRetain) break
    if (start < units.length && recentTokens + unit.tokens > recentBudget) break
    if (index === 0 && units.length > 1) break
    start = index
    recentTokens += unit.tokens
  }
  return {
    summaryUnits: units.slice(0, start),
    recentUnits: units.slice(start),
  }
}

/** Rebuild the active context for sessions compacted before checkpoints existed. */
export function restoreLegacyCompactionContext<Message>(
  messages: readonly Message[],
  contextWindow: number,
  tokensBefore: number,
  summary: string,
  timestamp: number,
  adapter: CompactionMessageAdapter<Message>,
): Message[] {
  const { recentUnits } = selectCompactionRanges(
    buildConversationUnits(messages, adapter),
    contextWindow,
    tokensBefore,
  )
  return [
    adapter.createSummaryMessage(summary, timestamp),
    ...recentUnits.flatMap((unit) => unit.messages),
  ]
}

export function validateToolMessagePairs<Message>(
  messages: readonly Message[],
  adapter: CompactionMessageAdapter<Message>,
): { valid: true } | { valid: false; error: string } {
  const units = buildConversationUnits(messages, adapter)
  const invalidIndex = units.findIndex((unit) => !unit.safeToRetain)
  return invalidIndex < 0
    ? { valid: true }
    : {
        valid: false,
        error: `Invalid tool-call/result pairing in conversation unit ${invalidIndex + 1}.`,
      }
}

/**
 * Manages context compression in three layers:
 * 1. Microcompact: Clear old tool results (cheap, no LLM call)
 * 2. Auto-compact: LLM-powered summary when context window fills
 * 3. Manual /compact: User-triggered compaction
 */
export class CompactionManager<Message> {
  private contextWindow: number
  private settings: CompactionSettings
  private onProgress?: (progress: CompactionProgress) => void
  private compacting = false
  private systemPromptTokens = 0
  private summarize: CompactionSummaryGenerator<Message>
  private readonly messageAdapter: CompactionMessageAdapter<Message>
  private readonly compactableToolNames: ReadonlySet<string>
  private progressStartedAt = 0

  constructor(options: {
    contextWindow: number
    messageAdapter: CompactionMessageAdapter<Message>
    compactableToolNames: ReadonlySet<string>
    summarize: CompactionSummaryGenerator<Message>
    settings?: Partial<CompactionSettings>
    onProgress?: (progress: CompactionProgress) => void
  }) {
    this.contextWindow = options.contextWindow
    this.settings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.settings }
    this.onProgress = options.onProgress
    this.messageAdapter = options.messageAdapter
    this.compactableToolNames = options.compactableToolNames
    this.summarize = options.summarize
  }

  reportProgress(progress: CompactionProgress): void {
    this.onProgress?.({
      ...progress,
      elapsedMs:
        progress.elapsedMs ?? Math.max(0, Date.now() - this.progressStartedAt),
    })
  }

  private emitProgress(
    progress: Omit<CompactionProgress, 'elapsedMs'>,
  ): void {
    this.onProgress?.({
      ...progress,
      elapsedMs: Math.max(0, Date.now() - this.progressStartedAt),
    })
  }

  /** Update system prompt token estimate (called when prompt changes). */
  setSystemPrompt(prompt: string): void {
    this.systemPromptTokens = Math.ceil(prompt.length / 4)
  }

  /** Previously compacted contexts can grow again and are eligible for another compaction. */
  isCompactionNeeded(messages: readonly Message[]): boolean {
    const messageTokens = this.messageAdapter.estimateTokens(messages)
    const tokens = messageTokens + this.systemPromptTokens
    return this.settings.enabled && tokens > this.contextWindow - this.settings.reserveTokens
  }

  /** Uses local character-based estimation for reliability (not dependent on API usage data). */
  getContextUsage(messages: readonly Message[]): {
    tokens: number
    messageTokens: number
    systemPromptTokens: number
    contextWindow: number
    percentUsed: number
    percentRemaining: number
  } {
    const messageTokens = this.messageAdapter.estimateTokens(messages)
    const tokens = messageTokens + this.systemPromptTokens
    const contextWindow = this.contextWindow
    const percentUsed = Math.round((tokens / contextWindow) * 100)
    return {
      tokens,
      messageTokens,
      systemPromptTokens: this.systemPromptTokens,
      contextWindow,
      percentUsed,
      percentRemaining: Math.max(0, 100 - percentUsed),
    }
  }

  /** Layer 1: Clear old tool results in-place without an LLM call. */
  microcompact(messages: Message[]): { messages: Message[]; cleared: number } {
    const toolResultIndices = new Map<string, number[]>()
    for (let i = 0; i < messages.length; i++) {
      const result = this.messageAdapter.getToolResult(messages[i]!)
      if (!result) continue
      const toolName = result.toolName ?? 'unknown'
      if (!this.compactableToolNames.has(toolName)) continue
      const indices = toolResultIndices.get(toolName) ?? []
      indices.push(i)
      toolResultIndices.set(toolName, indices)
    }

    const clearIndices = new Set<number>()
    for (const indices of toolResultIndices.values()) {
      const toClear = indices.slice(0, Math.max(0, indices.length - KEEP_RECENT_TOOLS))
      for (const index of toClear) clearIndices.add(index)
    }

    if (clearIndices.size === 0) return { messages, cleared: 0 }
    const newMessages = messages.map((message, index) =>
      clearIndices.has(index)
        ? this.messageAdapter.replaceToolResultContent(message, CLEARED_MESSAGE)
        : message,
    )
    return { messages: newMessages, cleared: clearIndices.size }
  }

  /** Shared implementation for automatic and manual compaction. */
  async compact(
    messages: Message[],
    customInstructions: string | undefined,
    automatic: boolean,
  ): Promise<ContextCompactionResult<Message>> {
    if (this.compacting) {
      throw new Error('Compaction already in progress')
    }
    this.compacting = true
    this.progressStartedAt = Date.now()
    const tokensBefore = this.messageAdapter.estimateTokens(messages)

    try {
      this.emitProgress({
        phase: 'analyzing',
        message: 'Analyzing conversation structure...',
        tokensBefore,
        progress: 5,
      })

      const units = buildConversationUnits(messages, this.messageAdapter)
      const { summaryUnits, recentUnits } = selectCompactionRanges(
        units,
        this.contextWindow,
        tokensBefore,
      )
      const messagesToSummarize = normalizeSummaryMessages(
        summaryUnits.length > 0 ? summaryUnits : units,
        this.messageAdapter,
      )
      const recentMessages = recentUnits.flatMap((unit) => unit.messages)

      this.emitProgress({
        phase: 'analyzing',
        message:
          `Summarizing ${summaryUnits.length} units; ` +
          `keeping ${recentUnits.length} recent units verbatim.`,
        tokensBefore,
        progress: 15,
        processedUnits: units.length,
        totalUnits: units.length,
      })

      let summaryProgress = 20
      const summaryMessage = automatic
        ? 'Auto-compacting earlier history...'
        : 'Summarizing earlier history...'
      this.emitProgress({
        phase: 'summarizing',
        message: summaryMessage,
        tokensBefore,
        progress: summaryProgress,
        processedUnits: summaryUnits.length,
        totalUnits: units.length,
      })
      const progressTimer = setInterval(() => {
        summaryProgress = Math.min(84, summaryProgress + 1)
        this.emitProgress({
          phase: 'summarizing',
          message: summaryMessage,
          tokensBefore,
          progress: summaryProgress,
          processedUnits: summaryUnits.length,
          totalUnits: units.length,
        })
      }, 250)

      let result
      try {
        result = await this.summarize(
          messagesToSummarize,
          {
            reserveTokens: this.settings.reserveTokens,
            ...(customInstructions === undefined ? {} : { instructions: customInstructions }),
          },
        )
      } finally {
        clearInterval(progressTimer)
      }

      if (!result.ok) {
        throw new Error(`Summarization failed: ${result.error.message}`)
      }

      const summary = result.value
      if (!summary || summary.trim().length === 0) {
        throw new Error('Summarization returned empty summary')
      }

      const newMessages = [
        this.messageAdapter.createSummaryMessage(summary, Date.now()),
        ...recentMessages,
      ]
      this.emitProgress({
        phase: 'validating',
        message: 'Validating compacted tool-call boundaries...',
        tokensBefore,
        progress: 88,
        processedUnits: units.length,
        totalUnits: units.length,
      })
      const validation = validateToolMessagePairs(newMessages, this.messageAdapter)
      if (!validation.valid) {
        throw new Error(`Compaction produced invalid context: ${validation.error}`)
      }
      const tokensAfter = this.messageAdapter.estimateTokens(newMessages)

      this.emitProgress({
        phase: 'validating',
        message: 'Compacted context is ready to commit.',
        tokensBefore,
        tokensAfter,
        progress: 90,
        processedUnits: units.length,
        totalUnits: units.length,
      })

      return {
        summary,
        messages: newMessages,
        tokensBefore,
        tokensAfter,
        keptMessageCount: recentMessages.length,
        automatic,
      }
    } catch (error) {
      this.emitProgress({
        phase: 'done',
        message: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        progress: 100,
      })
      throw error
    } finally {
      this.compacting = false
    }
  }

  isCompacting(): boolean {
    return this.compacting
  }

  setContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow
  }
}

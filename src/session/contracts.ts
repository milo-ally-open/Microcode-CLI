export interface CompactionToolCall {
  id: string
  name: string
  arguments: unknown
}

export interface CompactionToolResult {
  callId: string
  toolName?: string
}

export type CompactionSummaryResult =
  | { ok: true; value: string }
  | { ok: false; error: { message: string } }

export type CompactionSummaryGenerator<Message> = (
  messages: readonly Message[],
  options: Readonly<{ reserveTokens: number; instructions?: string }>,
) => Promise<CompactionSummaryResult>

/**
 * Kernel-specific transcript behavior required by the kernel-independent
 * compaction policy. Implementations belong beside their kernel adapter.
 */
export interface CompactionMessageAdapter<Message> {
  getToolCalls(message: Message): readonly CompactionToolCall[]
  getToolResult(message: Message): CompactionToolResult | undefined
  getTimestamp(message: Message): number | undefined
  estimateTokens(messages: readonly Message[]): number
  formatMalformedUnit(messages: readonly Message[]): string
  createUserMessage(content: string, timestamp: number): Message
  createSummaryMessage(summary: string, timestamp: number): Message
  replaceToolResultContent(message: Message, content: string): Message
}

/** Minimal persisted session metadata exposed to the runtime layer. */
export interface RuntimeSessionMetadata {
  readonly id: string
  readonly cwd: string
  readonly createdAt: number
  readonly path: string
  readonly modifiedAt?: number
}

/** Serializable archive entries needed to rebuild the active transcript. */
export type SessionArchiveEntry<Message> =
  | { readonly type: 'message'; readonly message: Message; readonly timestamp: number }
  | { readonly type: 'compaction'; readonly summary: string; readonly retainedTail: readonly Message[]; readonly timestamp: number }
  | { readonly type: 'branch_summary'; readonly summary: string; readonly timestamp: number }
  | { readonly type: 'custom'; readonly customType: string; readonly data?: unknown; readonly timestamp: number }

/** Storage operations required by the runtime-owned session lifecycle. */
export interface SessionStore<Message, Metadata extends RuntimeSessionMetadata = RuntimeSessionMetadata> {
  create(cwd: string): Promise<Metadata>
  open(metadata: Metadata): Promise<void>
  list(cwd?: string): Promise<Metadata[]>
  appendMessage(message: Message): Promise<void>
  appendCustomEntry(type: string, data: unknown): Promise<void>
  loadEntries(): Promise<SessionArchiveEntry<Message>[]>
  delete(metadata: Metadata): Promise<void>
  close(): Promise<void>
}

/** Transcript compatibility operations supplied by the selected kernel adapter. */
export interface SessionTranscriptAdapter<Message> {
  replaceImagesForPersistence(message: Message): Message
  restoreLegacyCompactionContext(
    messages: readonly Message[],
    legacyMessage: Message,
    timestamp: number,
  ): readonly Message[] | undefined
  createSummaryMessage(summary: string, timestamp: number, kind: 'compaction' | 'branch_summary'): Message
}

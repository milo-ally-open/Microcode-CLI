/** Runtime-facing contract for an agent kernel; implementations stay behind adapters. */
export interface KernelToolCallRequest {
  toolName: string
  input: Record<string, unknown>
}

export interface KernelToolCallDecision {
  block?: boolean
  reason?: string
}

export type KernelBeforeToolCall = (
  request: KernelToolCallRequest,
) => Promise<KernelToolCallDecision | undefined>

export interface KernelToolSetUpdate<Tool> {
  readonly toolName: string
  setTools(tools: readonly Tool[]): void
}

export type KernelAfterToolCall<Tool> = (
  update: KernelToolSetUpdate<Tool>,
) => Promise<void> | void

export interface KernelAssistantMessageEvent<Message> {
  readonly type: string
  readonly contentIndex?: number
  readonly delta?: string
  readonly content?: unknown
  readonly partial?: Message
  readonly message?: Message
  readonly error?: Message
  readonly toolCall?: {
    readonly id: string
    readonly name: string
    readonly arguments: Record<string, unknown>
    readonly namespace?: string
  }
  readonly reason?: string
}

/** Kernel-neutral lifecycle events; implementations map their native event unions at the adapter boundary. */
export type KernelAgentEvent<Message> =
  | { readonly type: 'agent_start' }
  | { readonly type: 'agent_end'; readonly messages: readonly Message[] }
  | { readonly type: 'turn_start' }
  | { readonly type: 'turn_end'; readonly message: Message; readonly toolResults: readonly Message[] }
  | { readonly type: 'message_start'; readonly message: Message }
  | { readonly type: 'message_update'; readonly message: Message; readonly assistantMessageEvent: KernelAssistantMessageEvent<Message> }
  | { readonly type: 'message_end'; readonly message: Message }
  | { readonly type: 'tool_execution_start'; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: 'tool_execution_update'; readonly toolCallId: string; readonly toolName: string; readonly args: unknown; readonly partialResult: unknown }
  | { readonly type: 'tool_execution_end'; readonly toolCallId: string; readonly toolName: string; readonly result: unknown; readonly isError: boolean }

export interface KernelAgentSnapshot<Message, Model, Tool, ThinkingLevel> {
  readonly systemPrompt: string
  readonly model: Model
  readonly thinkingLevel: ThinkingLevel
  readonly tools: readonly Tool[]
  readonly messages: readonly Message[]
  readonly isStreaming: boolean
  readonly pendingToolCalls: ReadonlySet<string>
  readonly errorMessage?: string
}

export interface KernelAgentPort<Message, Model, Tool, Event, ThinkingLevel, Image = unknown> {
  getSnapshot(): KernelAgentSnapshot<Message, Model, Tool, ThinkingLevel>
  getMessages(): readonly Message[]
  setMessages(messages: readonly Message[]): void
  setModel(model: Model): void
  setThinkingLevel(level: ThinkingLevel): void
  setTools(tools: readonly Tool[]): void
  subscribe(listener: (event: Event, signal: AbortSignal) => Promise<void> | void): () => void
  prompt(message: string | Message | Message[], images?: Image[]): Promise<void>
  steer(message: Message): void
  followUp(message: Message): void
  abort(): void
  waitForIdle(): Promise<void>
}

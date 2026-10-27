/** Neutral model-layer messages. Kernel-specific message types stop at adapters. */
export interface ModelTextBlock {
  type: 'text'
  text: string
  signature?: string
}

export interface ModelImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

export interface ModelThinkingBlock {
  type: 'thinking'
  text: string
  signature?: string
  redacted?: boolean
}

export interface ModelToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  arguments: Record<string, unknown>
  thoughtSignature?: string
  namespace?: string
}

export type ModelPromptBlock = ModelTextBlock | ModelImageBlock | ModelThinkingBlock | ModelToolCallBlock
export type ModelOutputBlock = ModelTextBlock | ModelThinkingBlock | ModelToolCallBlock

export interface ModelToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  constrainedSampling?: unknown
}

export type ModelPromptMessage =
  | {
      role: 'system'
      content: string | ModelTextBlock[]
      sections?: Record<string, string | null>
      toolsAdded?: ModelToolDefinition[]
      toolsRemoved?: Array<{ name: string }>
      timestamp: number
    }
  | { role: 'user'; content: string | Array<ModelTextBlock | ModelImageBlock>; timestamp: number }
  | {
      role: 'assistant'
      content: ModelOutputBlock[]
      apiId: string
      providerId: string
      modelId: string
      responseModel?: string
      responseId?: string
      providerThinkingLevel?: string
      diagnostics?: unknown[]
      deferred?: unknown
      usage: ModelUsage
      stopReason: string
      errorMessage?: string
      rawStopReason?: string
      endTurn?: boolean
      timestamp: number
    }
  | {
      role: 'tool_result'
      toolCallId: string
      toolName: string
      content: Array<ModelTextBlock | ModelImageBlock>
      details?: unknown
      usage?: ModelUsage
      isError: boolean
      timestamp: number
    }

export interface ModelInferenceContext {
  systemPrompt?: string
  messages: ModelPromptMessage[]
  tools?: ModelToolDefinition[]
}

export interface ModelUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  reasoning?: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface ModelCompletion {
  content: ModelOutputBlock[]
  apiId: string
  providerId: string
  modelId: string
  responseModel?: string
  responseId?: string
  providerThinkingLevel?: string
  diagnostics?: unknown[]
  deferred?: unknown
  usage: ModelUsage
  stopReason: string
  errorMessage?: string
  rawStopReason?: string
  endTurn?: boolean
  timestamp: number
}

export type ModelStreamEvent =
  | { type: 'start'; partial: ModelCompletion }
  | { type: 'text_start'; contentIndex: number; partial: ModelCompletion }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: ModelCompletion }
  | { type: 'text_end'; contentIndex: number; content: string; partial: ModelCompletion }
  | { type: 'thinking_start'; contentIndex: number; partial: ModelCompletion }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: ModelCompletion }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: ModelCompletion }
  | { type: 'toolcall_start'; contentIndex: number; partial: ModelCompletion }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: ModelCompletion }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ModelToolCallBlock; partial: ModelCompletion }
  | { type: 'done'; reason: string; message: ModelCompletion }
  | { type: 'error'; reason: string; error: ModelCompletion }

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tiers?: readonly (ModelCostRates & { inputTokensAbove: number })[]
}

/** Stable model description for the Gateway; fields contain data, never Pi objects. */
export interface ModelRuntimeDescriptor {
  id: string
  name: string
  provider: string
  api: string
  input: readonly string[]
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  cost: ModelCostRates
  thinkingLevelMap?: Readonly<Record<string, string | null>>
  samplingParams?: Readonly<Record<string, unknown>>
  promptCache?: Readonly<Record<string, number>>
  inputLimits?: Readonly<Record<string, unknown>>
  compat?: Readonly<Record<string, unknown>>
}

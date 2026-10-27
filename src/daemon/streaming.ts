import type { ModelStreamEvent } from '../models/inference.ts'
import { OpenAiChatStreamAdapter } from './protocol/openaiChatStream.ts'
import { AnthropicMessagesStreamAdapter } from './protocol/anthropicMessagesStream.ts'
import { OpenAiResponsesStreamAdapter } from './protocol/openaiResponsesStream.ts'
import { GeminiGenerateContentStreamAdapter } from './protocol/geminiGenerateStream.ts'
import type { GatewayDialect, GatewayModelIdentity } from './types.ts'
import type { GatewayStreamAdapter, SseEvent } from './protocol/streamTypes.ts'
export async function* protocolEvents(
  dialect: GatewayDialect,
  events: AsyncIterable<ModelStreamEvent>,
  model: GatewayModelIdentity,
  anthropicThinkingDisplay?: 'summarized' | 'omitted',
  includeReasoningSummary = false,
  responsesToolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
): AsyncGenerator<SseEvent> {
  yield* createProtocolStreamAdapter(dialect, model, {
    anthropicThinkingDisplay,
    includeReasoningSummary,
    responsesToolNamespaces,
  }).convert(events)
}

export function createProtocolStreamAdapter(
  dialect: GatewayDialect,
  model: GatewayModelIdentity,
  options: {
    anthropicThinkingDisplay?: 'summarized' | 'omitted'
    includeReasoningSummary?: boolean
    responsesToolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>
  } = {},
): GatewayStreamAdapter {
  if (dialect === 'openai-chat') return new OpenAiChatStreamAdapter(model)
  if (dialect === 'anthropic-messages') return new AnthropicMessagesStreamAdapter(model, options.anthropicThinkingDisplay)
  if (dialect === 'openai-responses') {
    return new OpenAiResponsesStreamAdapter(model, options.includeReasoningSummary, options.responsesToolNamespaces)
  }
  throw new Error('Internal RPC does not use public SSE events.')
}

/** Encodes protocol events as SSE frames for one selected public dialect. */
export class SseFrameEncoder {
  private readonly textEncoder = new TextEncoder()

  constructor(private readonly dialect: GatewayDialect) {}

  encode(item: SseEvent): Uint8Array {
    const data = typeof item.data === 'string' ? item.data : JSON.stringify(item.data)
    const prefix = this.dialect === 'anthropic-messages' || this.dialect === 'openai-responses'
      ? `event: ${item.event ?? 'message'}\n`
      : ''
    return this.textEncoder.encode(`${prefix}data: ${data}\n\n`)
  }
}

export function sseChunk(dialect: GatewayDialect, item: SseEvent): Uint8Array {
  return new SseFrameEncoder(dialect).encode(item)
}

export { OpenAiChatStreamAdapter, openAiChatEvents } from './protocol/openaiChatStream.ts'
export { AnthropicMessagesStreamAdapter, anthropicEvents } from './protocol/anthropicMessagesStream.ts'
export { OpenAiResponsesStreamAdapter, responsesEvents } from './protocol/openaiResponsesStream.ts'
export { GeminiGenerateContentStreamAdapter, geminiEvents } from './protocol/geminiGenerateStream.ts'
export { plainText } from './protocol.ts'

import type { ModelCompletion, ModelStreamEvent } from '../../models/inference.ts'
import type { GatewayModelIdentity } from '../types.ts'
import type { GatewayStreamAdapter, SseEvent } from './streamTypes.ts'

/** Owns message/content-block lifecycle state for one Anthropic Messages stream. */
export class AnthropicMessagesStreamAdapter implements GatewayStreamAdapter {
  private messageId = `msg_${crypto.randomUUID()}`
  private readonly opened = new Set<number>()
  private readonly textDeltas = new Map<number, string>()
  private readonly argumentLengths = new Map<number, number>()
  private emittedStart = false

  constructor(
    private readonly model: GatewayModelIdentity,
    private readonly thinkingDisplay: 'summarized' | 'omitted' = 'summarized',
  ) {}

  private start(partial?: ModelCompletion): SseEvent[] {
    if (this.emittedStart) return []
    this.emittedStart = true
    // Provider response IDs are opaque upstream identifiers, not gateway IDs.
    this.messageId = `msg_${crypto.randomUUID()}`
    return [{ event: 'message_start', data: { type: 'message_start', message: { id: this.messageId, type: 'message', role: 'assistant', model: `${this.model.provider}/${this.model.id}`, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: partial?.usage.input ?? 0, output_tokens: 0 } } } }]
  }

  async *convert(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<SseEvent> {
    const { model, thinkingDisplay } = this
    for await (const event of events) {
      if (event.type === 'start') {
        for (const output of this.start(event.partial)) yield output
      } else if (event.type === 'text_start') {
        for (const output of this.start(event.partial)) yield output
        this.opened.add(event.contentIndex)
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'text', text: '' } } }
      } else if (event.type === 'text_delta') {
        this.textDeltas.set(event.contentIndex, (this.textDeltas.get(event.contentIndex) ?? '') + event.delta)
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'text_delta', text: event.delta } } }
      } else if (event.type === 'text_end') {
        if (!this.opened.has(event.contentIndex)) {
          yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'text', text: '' } } }
        }
        const streamedText = this.textDeltas.get(event.contentIndex) ?? ''
        const finalSuffix = event.content.startsWith(streamedText) ? event.content.slice(streamedText.length) : streamedText ? '' : event.content
        if (finalSuffix) {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'text_delta', text: finalSuffix } } }
        }
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: event.contentIndex } }
        this.opened.delete(event.contentIndex)
        this.textDeltas.delete(event.contentIndex)
      } else if (event.type === 'thinking_start') {
        for (const output of this.start(event.partial)) yield output
        this.opened.add(event.contentIndex)
        const thinking = event.partial.content[event.contentIndex]
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'thinking', thinking: '', signature: thinking?.type === 'thinking' ? thinking.signature ?? '' : '' } } }
      } else if (event.type === 'thinking_delta') {
        if (thinkingDisplay !== 'omitted') {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'thinking_delta', thinking: event.delta } } }
        }
      } else if (event.type === 'thinking_end') {
        const thinking = event.partial.content[event.contentIndex]
        const signature = thinking?.type === 'thinking' ? thinking.signature : undefined
        if (!this.opened.has(event.contentIndex)) {
          yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'thinking', thinking: '', signature: signature ?? '' } } }
        }
        if (thinkingDisplay === 'omitted') {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'thinking_delta', thinking: '' } } }
        } else if (event.content && !(thinking?.type === 'thinking' && thinking.redacted)) {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'thinking_delta', thinking: event.content } } }
        }
        if (signature) {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'signature_delta', signature } } }
        }
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: event.contentIndex } }
        this.opened.delete(event.contentIndex)
      } else if (event.type === 'toolcall_start') {
        for (const output of this.start(event.partial)) yield output
        const call = event.partial.content[event.contentIndex]
        if (call?.type !== 'tool_call') continue
        this.opened.add(event.contentIndex)
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } } }
      } else if (event.type === 'toolcall_delta') {
        this.argumentLengths.set(event.contentIndex, (this.argumentLengths.get(event.contentIndex) ?? 0) + event.delta.length)
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'input_json_delta', partial_json: event.delta } } }
      } else if (event.type === 'toolcall_end') {
        if (!this.opened.has(event.contentIndex)) yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'tool_use', id: event.toolCall.id, name: event.toolCall.name, input: {} } } }
        if ((this.argumentLengths.get(event.contentIndex) ?? 0) === 0 && Object.keys(event.toolCall.arguments).length > 0) {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.toolCall.arguments) } } }
        }
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: event.contentIndex } }
        this.opened.delete(event.contentIndex)
      } else if (event.type === 'done') {
        for (const index of this.opened) yield { event: 'content_block_stop', data: { type: 'content_block_stop', index } }
        const stopReason = event.reason === 'toolUse' ? 'tool_use' : event.reason === 'length' ? 'max_tokens' : 'end_turn'
        yield { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: event.message.usage.output } } }
        yield { event: 'message_stop', data: { type: 'message_stop' } }
        return
      } else if (event.type === 'error') {
        yield { event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'The model request failed.' } } }
        return
      }
    }
  }
}
export async function* anthropicEvents(
  events: AsyncIterable<ModelStreamEvent>,
  model: GatewayModelIdentity,
  thinkingDisplay: 'summarized' | 'omitted' = 'summarized',
): AsyncGenerator<SseEvent> {
  yield* new AnthropicMessagesStreamAdapter(model, thinkingDisplay).convert(events)
}

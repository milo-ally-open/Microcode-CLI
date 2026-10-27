import type { ModelStreamEvent } from '../../models/inference.ts'
import type { GatewayModelIdentity } from '../types.ts'
import type { GatewayStreamAdapter, SseEvent } from './streamTypes.ts'
import { finishReason } from './streamTypes.ts'

/** Owns per-response state required to translate normalized model events to Chat Completions chunks. */
export class OpenAiChatStreamAdapter implements GatewayStreamAdapter {
  private readonly id = `chatcmpl_${crypto.randomUUID()}`
  private created = Math.floor(Date.now() / 1000)
  private started = false
  private readonly toolIndexes = new Map<number, number>()
  private nextToolIndex = 0
  private readonly toolArgumentLengths = new Map<number, number>()

  constructor(private readonly model: GatewayModelIdentity) {}

  async *convert(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<SseEvent> {
    const { model } = this
    for await (const event of events) {
      if (event.type === 'start') {
        this.created = Math.floor(event.partial.timestamp / 1000)
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } }
        this.started = true
      } else if (event.type === 'text_delta') {
        if (!this.started) continue
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] } }
      } else if (event.type === 'toolcall_start') {
        const call = event.partial.content[event.contentIndex]
        if (call?.type !== 'tool_call') continue
        const index = this.nextToolIndex++
        this.toolIndexes.set(event.contentIndex, index)
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] } }
      } else if (event.type === 'toolcall_delta') {
        const index = this.toolIndexes.get(event.contentIndex)
        if (index === undefined) continue
        this.toolArgumentLengths.set(event.contentIndex, (this.toolArgumentLengths.get(event.contentIndex) ?? 0) + event.delta.length)
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta } }] }, finish_reason: null }] } }
      } else if (event.type === 'toolcall_end') {
        const index = this.toolIndexes.get(event.contentIndex)
        if (index === undefined) continue
        const serialized = JSON.stringify(event.toolCall.arguments)
        if ((this.toolArgumentLengths.get(event.contentIndex) ?? 0) === 0 && serialized !== '{}') {
          yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: serialized } }] }, finish_reason: null }] } }
        }
      } else if (event.type === 'done') {
        if (!this.started) {
          yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } }
        }
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: {}, finish_reason: finishReason(event.reason) }], usage: { prompt_tokens: event.message.usage.input, completion_tokens: event.message.usage.output, total_tokens: event.message.usage.totalTokens } } }
        yield { data: '[DONE]' }
        return
      } else if (event.type === 'error') {
        yield { data: { error: { message: 'The model request failed.', type: 'server_error' } } }
        yield { data: '[DONE]' }
        return
      }
    }
  }
}
export async function* openAiChatEvents(
  events: AsyncIterable<ModelStreamEvent>,
  model: GatewayModelIdentity,
): AsyncGenerator<SseEvent> {
  yield* new OpenAiChatStreamAdapter(model).convert(events)
}

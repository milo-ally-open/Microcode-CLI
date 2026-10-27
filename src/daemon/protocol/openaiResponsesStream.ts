import type { ModelCompletion, ModelStreamEvent } from '../../models/inference.ts'
import { responsesToolName, serializeResponses } from '../protocol.ts'
import type { GatewayModelIdentity } from '../types.ts'
import type { GatewayStreamAdapter, SseEvent } from './streamTypes.ts'

/** Owns the indexed output-item state for one OpenAI Responses stream. */
export class OpenAiResponsesStreamAdapter implements GatewayStreamAdapter {
  private readonly id = `resp_${crypto.randomUUID()}`
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private readonly output: any[] = []
  private readonly itemIndexes = new Map<number, number>()
  private readonly textIndexes = new Map<number, number>()
  private readonly textParts: string[] = []
  private messageOutputIndex = -1
  private nextOutputIndex = 0
  private nextTextIndex = 0
  private readonly toolArgumentLengths = new Map<number, number>()
  private readonly reasoningIndexes = new Map<number, number>()

  constructor(
    private readonly model: GatewayModelIdentity,
    private readonly includeReasoningSummary = false,
    private readonly toolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
  ) {}

  private get responseBase() {
    return { id: this.id, object: 'response', created_at: this.createdAt, model: `${this.model.provider}/${this.model.id}` }
  }

  private ensureReasoningItem(contentIndex: number, partial: ModelCompletion): SseEvent[] {
    if (!this.includeReasoningSummary) return []
    const block = partial.content[contentIndex]
    if (block?.type !== 'thinking' || block.redacted || this.reasoningIndexes.has(contentIndex)) return []
    const outputIndex = this.nextOutputIndex++
    this.reasoningIndexes.set(contentIndex, outputIndex)
    this.output[outputIndex] = { type: 'reasoning', id: `rs_${crypto.randomUUID()}`, status: 'in_progress', summary: [{ type: 'summary_text', text: '' }] }
    return [
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: outputIndex, item: this.output[outputIndex] } },
      { event: 'response.reasoning_summary_part.added', data: { type: 'response.reasoning_summary_part.added', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, part: this.output[outputIndex].summary[0] } },
    ]
  }

  async *convert(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<SseEvent> {
    const { model, includeReasoningSummary, toolNamespaces } = this
    const responseBase = this.responseBase
    yield { event: 'response.created', data: { type: 'response.created', response: { ...responseBase, status: 'in_progress', output: [] } } }
    yield { event: 'response.in_progress', data: { type: 'response.in_progress', response: { ...responseBase, status: 'in_progress', output: [] } } }
    for await (const event of events) {
      if (event.type === 'text_start') {
        if (this.messageOutputIndex < 0) {
          this.messageOutputIndex = this.nextOutputIndex++
          this.output.push({ type: 'message', id: `msg_${crypto.randomUUID()}`, status: 'in_progress', role: 'assistant', content: [] })
          yield { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: this.messageOutputIndex, item: this.output[this.messageOutputIndex] } }
        }
        const contentIndex = this.nextTextIndex++
        this.textIndexes.set(event.contentIndex, contentIndex)
        this.textParts[contentIndex] = ''
        const part = { type: 'output_text', text: '', annotations: [], logprobs: [] }
        this.output[this.messageOutputIndex].content[contentIndex] = part
        yield { event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, part } }
      } else if (event.type === 'text_delta') {
        const contentIndex = this.textIndexes.get(event.contentIndex)
        if (contentIndex === undefined || this.messageOutputIndex < 0) continue
        this.textParts[contentIndex] = (this.textParts[contentIndex] ?? '') + event.delta
        yield { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, delta: event.delta, logprobs: [] } }
      } else if (event.type === 'text_end') {
        const contentIndex = this.textIndexes.get(event.contentIndex)
        if (contentIndex === undefined || this.messageOutputIndex < 0) continue
        if (!this.textParts[contentIndex] && event.content) this.textParts[contentIndex] = event.content
        const text = this.textParts[contentIndex] ?? ''
        this.output[this.messageOutputIndex].content[contentIndex].text = text
        yield { event: 'response.output_text.done', data: { type: 'response.output_text.done', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, text, logprobs: [] } }
        yield { event: 'response.content_part.done', data: { type: 'response.content_part.done', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, part: this.output[this.messageOutputIndex].content[contentIndex] } }
      } else if (event.type === 'thinking_start') {
        for (const frame of this.ensureReasoningItem(event.contentIndex, event.partial)) yield frame
      } else if (event.type === 'thinking_delta') {
        for (const frame of this.ensureReasoningItem(event.contentIndex, event.partial)) yield frame
        const outputIndex = this.reasoningIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        const part = this.output[outputIndex].summary[0]
        part.text += event.delta
        yield { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, delta: event.delta } }
      } else if (event.type === 'thinking_end') {
        for (const frame of this.ensureReasoningItem(event.contentIndex, event.partial)) yield frame
        const outputIndex = this.reasoningIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        const part = this.output[outputIndex].summary[0]
        if (!part.text && event.content) {
          part.text = event.content
          yield { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, delta: event.content } }
        }
        yield { event: 'response.reasoning_summary_text.done', data: { type: 'response.reasoning_summary_text.done', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, text: part.text } }
        yield { event: 'response.reasoning_summary_part.done', data: { type: 'response.reasoning_summary_part.done', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, part } }
        this.output[outputIndex].status = 'completed'
        yield { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: outputIndex, item: this.output[outputIndex] } }
      } else if (event.type === 'toolcall_start') {
        const call = event.partial.content[event.contentIndex]
        if (call?.type !== 'tool_call') continue
        const outputIndex = this.nextOutputIndex++
        this.itemIndexes.set(event.contentIndex, outputIndex)
        this.output[outputIndex] = { type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: call.id, ...responsesToolName(call.name, toolNamespaces), arguments: '', status: 'in_progress' }
        yield { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: outputIndex, item: this.output[outputIndex] } }
      } else if (event.type === 'toolcall_delta') {
        const outputIndex = this.itemIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        this.output[outputIndex].arguments += event.delta
        this.toolArgumentLengths.set(event.contentIndex, (this.toolArgumentLengths.get(event.contentIndex) ?? 0) + event.delta.length)
        yield { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, delta: event.delta } }
      } else if (event.type === 'toolcall_end') {
        const outputIndex = this.itemIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        if ((this.toolArgumentLengths.get(event.contentIndex) ?? 0) === 0) {
          this.output[outputIndex].arguments = JSON.stringify(event.toolCall.arguments)
          yield { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, delta: this.output[outputIndex].arguments } }
        }
        this.output[outputIndex].status = 'completed'
        yield { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', item_id: this.output[outputIndex].id, output_index: outputIndex, arguments: this.output[outputIndex].arguments } }
        yield { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: outputIndex, item: this.output[outputIndex] } }
      } else if (event.type === 'done') {
        if (this.messageOutputIndex >= 0) {
          this.output[this.messageOutputIndex].status = 'completed'
          yield { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: this.messageOutputIndex, item: this.output[this.messageOutputIndex] } }
        }
        const completed = serializeResponses(event.message, model, includeReasoningSummary, toolNamespaces)
        completed.id = this.id
        completed.created_at = this.createdAt
        completed.output = this.output
        yield { event: 'response.completed', data: { type: 'response.completed', response: completed } }
        return
      } else if (event.type === 'error') {
        yield { event: 'response.failed', data: { type: 'response.failed', response: { ...responseBase, status: 'failed', error: { code: 'server_error', message: 'The model request failed.' }, output: this.output } } }
        return
      }
    }
  }
}
export async function* responsesEvents(
  events: AsyncIterable<ModelStreamEvent>,
  model: GatewayModelIdentity,
  includeReasoningSummary = false,
  toolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
): AsyncGenerator<SseEvent> {
  yield* new OpenAiResponsesStreamAdapter(model, includeReasoningSummary, toolNamespaces).convert(events)
}

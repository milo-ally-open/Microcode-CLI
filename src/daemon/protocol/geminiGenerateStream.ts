import type { ModelStreamEvent } from '../../models/inference.ts'
import type { GatewayModelIdentity } from '../types.ts'
import type { GatewayStreamAdapter, SseEvent } from './streamTypes.ts'

/** Emits one Gemini GenerateContentResponse object per SSE data frame. */
export class GeminiGenerateContentStreamAdapter implements GatewayStreamAdapter {
  constructor(private readonly model: GatewayModelIdentity) {}

  async *convert(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<SseEvent> {
    for await (const event of events) {
      if (event.type === 'text_delta' && event.delta) {
        yield { data: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: event.delta }] } }] } }
      } else if (event.type === 'toolcall_end') {
        yield { data: { candidates: [{
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { id: event.toolCall.id, name: event.toolCall.name, args: event.toolCall.arguments } }] },
        }] } }
      } else if (event.type === 'done') {
        if (event.message.content.some((block) => block.type !== 'text' && block.type !== 'thinking' && block.type !== 'tool_call')) {
          yield { data: { error: { code: 502, status: 'UNAVAILABLE', message: 'Gemini response contains an unsupported output modality.' } } }
          return
        }
        yield { data: {
          candidates: [{ index: 0, finishReason: event.reason === 'length' ? 'MAX_TOKENS' : 'STOP' }],
          usageMetadata: {
            promptTokenCount: event.message.usage.input,
            candidatesTokenCount: event.message.usage.output,
            totalTokenCount: event.message.usage.totalTokens,
          },
          modelVersion: this.model.id,
          responseId: event.message.responseId ?? `gemini_${crypto.randomUUID()}`,
        } }
        return
      } else if (event.type === 'error') {
        yield { data: { error: { code: 502, status: 'UNAVAILABLE', message: 'The model request failed.' } } }
        return
      }
    }
  }
}
export async function* geminiEvents(
  events: AsyncIterable<ModelStreamEvent>,
  model: GatewayModelIdentity,
): AsyncGenerator<SseEvent> {
  yield* new GeminiGenerateContentStreamAdapter(model).convert(events)
}

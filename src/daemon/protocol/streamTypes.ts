import type { ModelStreamEvent } from '../../models/inference.ts'

export interface SseEvent {
  event?: string
  data: unknown
}

export interface GatewayStreamAdapter {
  convert(events: AsyncIterable<ModelStreamEvent>): AsyncGenerator<SseEvent>
}

export function finishReason(reason: string): string {
  if (reason === 'toolUse') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'stop'
}

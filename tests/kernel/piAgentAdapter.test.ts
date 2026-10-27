import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import { createPiKernelAgent } from '../../src/kernel/pi/agent.ts'
import { findModel } from '../../src/models/registry.ts'

describe('Pi kernel adapter', () => {
  test('forwards prompt lifecycle through the runtime kernel port', async () => {
    const model = findModel('deepseek-v4-pro', undefined, 'deepseek')!
    const events: string[] = []
    const kernel = createPiKernelAgent({
      initialState: { systemPrompt: 'Test system prompt', model, tools: [] },
      streamFn: (requestModel) => {
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Adapter response.' }],
          api: requestModel.api,
          provider: requestModel.provider,
          model: requestModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        } as AssistantMessage
        const stream = createAssistantMessageEventStream()
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
        return stream
      },
    })

    kernel.subscribe((event) => events.push(event.type))
    await kernel.prompt('Hello kernel adapter.')

    const snapshot = kernel.getSnapshot()
    expect(snapshot.systemPrompt).toBe('Test system prompt')
    expect(snapshot.messages.map((message) => message.role)).toContain('assistant')
    expect(snapshot.isStreaming).toBe(false)
    expect(events).toContain('agent_start')
    expect(events).toContain('agent_end')
  })
})

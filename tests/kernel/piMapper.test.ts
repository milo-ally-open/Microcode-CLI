import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import { toRuntimeMessage, toRuntimeModel } from '../../src/kernel/pi/mapper.ts'
import { toRuntimeAgentEvent } from '../../src/agent/runtimeProjection.ts'
import type { RuntimeMessage } from '../../src/runtime/contracts.ts'
import { getAllModels } from '../../src/models/index.ts'

function assistantMessage(): AssistantMessage {
  const model = getAllModels().find((entry) => entry.provider === 'deepseek')!
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Hello', textSignature: 'private-text-signature' },
      { type: 'thinking', thinking: 'hidden reasoning', thinkingSignature: 'private-thinking-signature' },
      { type: 'toolCall', id: 'call-1', name: 'grep', arguments: { pattern: 'needle' }, thoughtSignature: 'private-tool-signature' },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 123,
  }
}

describe('Pi to runtime DTO mapper', () => {
  test('projects kernel-neutral runtime messages without requiring Pi message types', () => {
    const message: RuntimeMessage = { role: 'user', content: 'hello', timestamp: 1 }
    const event = toRuntimeAgentEvent({
      type: 'message_start',
      agentId: 'agent-1',
      message,
    }, (value) => value)

    expect(event).toEqual({ type: 'message_start', payload: { agent_id: 'agent-1', message } })
  })

  test('maps transcripts to Pi-free messages without provider signatures or runtime objects', () => {
    const assistant = toRuntimeMessage(assistantMessage())
    expect(assistant).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'thinking', text: '', redacted: true },
        { type: 'tool_call', call_id: 'call-1', tool_id: 'grep', arguments: { pattern: 'needle' } },
      ],
      model: { provider_id: 'deepseek', model_id: assistantMessage().model, api_id: assistantMessage().api },
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, cost: 0 },
      stop_reason: 'toolUse',
      timestamp: 123,
    })
    expect(JSON.stringify(assistant)).not.toContain('private-')
    expect(JSON.stringify(assistant)).not.toContain('hidden reasoning')

    const user = toRuntimeMessage({
      role: 'user',
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      timestamp: 124,
    })
    expect(user).toEqual({
      role: 'user',
      content: [{ type: 'image', data: 'aW1hZ2U=', mime_type: 'image/png' }],
      timestamp: 124,
    })

    expect(toRuntimeMessage({
      role: 'custom',
      customType: 'task-reminder',
      content: 'Reminder text',
      display: false,
      timestamp: 125,
    })).toEqual({
      role: 'custom', kind: 'task-reminder', content: 'Reminder text', display: false, timestamp: 125,
    })
  })

  test('maps model metadata without exposing base URLs or credentials', () => {
    const model = getAllModels().find((entry) => entry.provider === 'deepseek')! as Model<any>
    const dto = toRuntimeModel(model)
    expect(dto).toMatchObject({
      id: `deepseek/${model.id}`,
      provider_id: 'deepseek',
      model_id: model.id,
      api_id: model.api,
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
    })
    expect(dto).not.toHaveProperty('baseUrl')
    expect(JSON.stringify(dto)).not.toContain('apiKey')
  })

  test('keeps kernel system instructions out of frontend message DTOs', () => {
    const system = toRuntimeMessage({
      role: 'system',
      content: 'private project and policy instructions',
      timestamp: 125,
    })
    expect(system).toEqual({ role: 'system', content: '[system instructions]', timestamp: 125 })
    expect(JSON.stringify(system)).not.toContain('private project')
  })

  test('maps streaming events to JSON DTOs with stable tool IDs', () => {
    const assistant = assistantMessage()
    const event = toRuntimeAgentEvent({
      type: 'message_update',
      agentId: 'agent-1',
      message: assistant,
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: ' there',
        partial: assistant,
      },
    }, toRuntimeMessage)
    expect(event).toMatchObject({
      type: 'message_update',
      payload: {
        agent_id: 'agent-1',
        assistant_event: { type: 'text_delta', content_index: 0, delta: ' there' },
        message: { role: 'assistant' },
      },
    })
    expect(JSON.stringify(event)).not.toContain('private-')
  })

  test('maps permission requests with a stable request ID and runtime field names', () => {
    const event = toRuntimeAgentEvent({
      type: 'permission_requested',
      agentId: 'agent-1',
      request: {
        requestId: 'request-1',
        kind: 'tool',
        toolName: 'bash',
        input: { command: 'pwd' },
        description: 'Run a command',
      },
    }, toRuntimeMessage)
    expect(event).toEqual({
      type: 'permission_requested',
      payload: {
        agent_id: 'agent-1',
        request: {
          request_id: 'request-1',
          kind: 'tool',
          tool_id: 'bash',
          input: { command: 'pwd' },
          description: 'Run a command',
        },
      },
    })
  })
})

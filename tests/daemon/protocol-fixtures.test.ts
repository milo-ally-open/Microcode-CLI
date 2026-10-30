import { describe, expect, test } from 'bun:test'
import { parseAnthropicRequest } from '../../src/daemon/protocol/anthropicMessages.ts'
import { parseGeminiRequest } from '../../src/daemon/protocol/geminiGenerate.ts'
import { parseOpenAiChatRequest } from '../../src/daemon/protocol/openaiChat.ts'
import { parseResponsesRequest } from '../../src/daemon/protocol/openaiResponses.ts'
import { serializeAnthropic } from '../../src/daemon/protocol/anthropicMessages.ts'
import { serializeGemini } from '../../src/daemon/protocol/geminiGenerate.ts'
import { serializeOpenAiChat } from '../../src/daemon/protocol/openaiChat.ts'
import { serializeResponses } from '../../src/daemon/protocol/openaiResponses.ts'
import { geminiEvents, protocolEvents } from '../../src/daemon/streaming.ts'
import type { GatewayChatRequest, GatewayModelIdentity } from '../../src/daemon/types.ts'
import type { ModelCompletion, ModelStreamEvent } from '../../src/models/inference.ts'

type FixtureName = 'openai-chat' | 'openai-responses' | 'gemini-generate' | 'anthropic-messages'
const fixtureUrl = (name: string) => new URL(`../fixtures/protocols/${name}`, import.meta.url)

function normalize(parsed: GatewayChatRequest) {
  return {
    modelId: parsed.modelId,
    stream: parsed.stream,
    maxTokens: parsed.options.maxTokens,
    messages: parsed.context.messages.map((message) => ({
      role: message.role,
      text: typeof message.content === 'string'
        ? message.content
        : message.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    })),
  }
}

function normalizeToolMessages(parsed: GatewayChatRequest) {
  const textBlocks = (content: string | Array<{ type: string; text?: string }>) => typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content.map((block) => block.type === 'text' ? { type: 'text', text: block.text } : { type: block.type })
  return {
    messages: parsed.context.messages.map((message) => {
      if (message.role === 'user') return { role: 'user', content: textBlocks(message.content as string | Array<{ type: string; text?: string }>) }
      if (message.role === 'assistant') return {
        role: 'assistant',
        content: message.content.map((block) => block.type === 'tool_call'
          ? { type: 'tool_call', id: block.id, name: block.name, arguments: block.arguments }
          : block.type === 'text' ? { type: 'text', text: block.text } : { type: block.type }),
      }
      if (message.role === 'tool_result') return {
        role: 'tool_result',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: textBlocks(message.content as Array<{ type: string; text?: string }>),
      }
      return { role: message.role, content: message.content }
    }),
    tools: parsed.context.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  }
}

function toolCompletion(): ModelCompletion {
  return {
    content: [{ type: 'tool_call', id: 'call_fixture', name: 'lookup', arguments: { query: 'answer' } }],
    apiId: 'openai-completions',
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
    usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: 1_700_000_000_000,
  }
}

function normalizeSerializedToolCall(value: Record<string, any>, dialect: FixtureName, model: GatewayModelIdentity) {
  if (dialect === 'openai-chat') {
    const call = value.choices[0].message.tool_calls[0]
    return { name: call.function.name, arguments: JSON.parse(call.function.arguments) }
  }
  if (dialect === 'openai-responses') {
    const call = value.output.find((item: Record<string, unknown>) => item.type === 'function_call')
    return { name: call.name, arguments: JSON.parse(call.arguments) }
  }
  if (dialect === 'gemini-generate') {
    const call = value.candidates[0].content.parts[0].functionCall
    return { name: call.name, arguments: call.args }
  }
  const call = value.content.find((item: Record<string, unknown>) => item.type === 'tool_use')
  expect(value.model).toBe(model.provider + '/' + model.id)
  return { name: call.name, arguments: call.input }
}

function streamEventLabel(dialect: FixtureName, frame: { event?: string; data: unknown }): string {
  if (dialect === 'openai-responses' || dialect === 'anthropic-messages') return frame.event ?? 'message'
  if (dialect === 'gemini-generate') {
    const data = frame.data as Record<string, any>
    const parts = data.candidates?.[0]?.content?.parts
    if (parts?.[0]?.text !== undefined) return 'text_delta'
    if (parts?.[0]?.functionCall !== undefined) return 'tool_call'
    return 'finish'
  }
  if (frame.data === '[DONE]') return 'done_marker'
  const data = frame.data as Record<string, any>
  const choice = data.choices?.[0]
  const delta = choice?.delta ?? {}
  if (delta.role) return 'assistant_role'
  if (delta.content !== undefined) return 'text_delta'
  if (delta.tool_calls?.[0]?.id) return 'tool_call_start'
  if (delta.tool_calls?.length) return 'tool_arguments_delta'
  return 'finish'
}

async function* toolStreamEvents(): AsyncGenerator<ModelStreamEvent> {
  const message = toolCompletion()
  const partial = { ...message, content: [{ type: 'text' as const, text: 'hello' }, ...message.content] }
  yield { type: 'start', partial }
  yield { type: 'text_start', contentIndex: 0, partial }
  yield { type: 'text_delta', contentIndex: 0, delta: 'hello', partial }
  yield { type: 'text_end', contentIndex: 0, content: 'hello', partial }
  yield { type: 'toolcall_start', contentIndex: 1, partial }
  yield { type: 'toolcall_delta', contentIndex: 1, delta: '{"query":', partial }
  yield { type: 'toolcall_delta', contentIndex: 1, delta: '"answer"}', partial }
  yield { type: 'toolcall_end', contentIndex: 1, toolCall: message.content[0] as Extract<ModelCompletion['content'][number], { type: 'tool_call' }>, partial }
  yield { type: 'done', reason: 'toolUse', message: partial }
}

describe('fixed client protocol fixtures', () => {
  test('normalizes the four supported request dialects to the recorded model contract', async () => {
    const expected = await Bun.file(fixtureUrl('normalized.expected.json')).json() as Record<FixtureName, unknown>
    const chat = await Bun.file(fixtureUrl('openai-chat.request.json')).json()
    const responses = await Bun.file(fixtureUrl('openai-responses.request.json')).json()
    const gemini = await Bun.file(fixtureUrl('gemini-generate.request.json')).json() as { model_id: string; stream: boolean; body: unknown }
    const anthropic = await Bun.file(fixtureUrl('anthropic-messages.request.json')).json()

    expect(normalize(parseOpenAiChatRequest(chat))).toEqual(expected['openai-chat'])
    expect(normalize(parseResponsesRequest(responses))).toEqual(expected['openai-responses'])
    expect(normalize(parseGeminiRequest(gemini.body, gemini.model_id, gemini.stream))).toEqual(expected['gemini-generate'])
    expect(normalize(parseAnthropicRequest(anthropic))).toEqual(expected['anthropic-messages'])
  })

  test('round-trips tool calls and tool results through all four request dialects', async () => {
    const requests = await Bun.file(fixtureUrl('tool-roundtrip.request.json')).json() as Record<FixtureName, any>
    const expected = await Bun.file(fixtureUrl('tool-roundtrip.expected.json')).json() as {
      normalizedMessages: unknown[]
      tool: unknown
      serializedCall: unknown
    }
    const model: GatewayModelIdentity = { provider: 'deepseek', id: 'deepseek-v4-pro' }
    const completion = toolCompletion()
    const parse = {
      'openai-chat': () => parseOpenAiChatRequest(requests['openai-chat']),
      'openai-responses': () => parseResponsesRequest(requests['openai-responses']),
      'gemini-generate': () => parseGeminiRequest(requests['gemini-generate'].body, requests['gemini-generate'].model_id, false),
      'anthropic-messages': () => parseAnthropicRequest(requests['anthropic-messages']),
    }
    const serialize = {
      'openai-chat': () => serializeOpenAiChat(completion, model),
      'openai-responses': () => serializeResponses(completion, model),
      'gemini-generate': () => serializeGemini(completion, model),
      'anthropic-messages': () => serializeAnthropic(completion, model),
    }

    for (const dialect of Object.keys(parse) as FixtureName[]) {
      const parsed = parse[dialect]()
      expect(normalizeToolMessages(parsed).messages).toEqual(expected.normalizedMessages)
      expect(normalizeToolMessages(parsed).tools?.[0]).toEqual(expected.tool)
      expect(normalizeSerializedToolCall(serialize[dialect]() as Record<string, any>, dialect, model)).toEqual(expected.serializedCall)
    }
  })

  test('rejects fixed unsupported-feature requests with the recorded client-facing error', async () => {
    const requests = await Bun.file(fixtureUrl('errors.request.json')).json() as Record<FixtureName, any>
    const expected = await Bun.file(fixtureUrl('errors.expected.json')).json() as Record<FixtureName, string>
    const parse = {
      'openai-chat': () => parseOpenAiChatRequest(requests['openai-chat']),
      'openai-responses': () => parseResponsesRequest(requests['openai-responses']),
      'gemini-generate': () => parseGeminiRequest(requests['gemini-generate'], 'deepseek/deepseek-v4-pro'),
      'anthropic-messages': () => parseAnthropicRequest(requests['anthropic-messages']),
    }

    for (const dialect of Object.keys(parse) as FixtureName[]) {
      expect(parse[dialect]).toThrow(expected[dialect])
    }
  })

  test('emits recorded tool-stream event order for all four dialects', async () => {
    const expected = await Bun.file(fixtureUrl('stream-order.expected.json')).json() as Record<FixtureName, string[]>
    const model: GatewayModelIdentity = { provider: 'deepseek', id: 'deepseek-v4-pro' }
    const streams = {
      'openai-chat': () => protocolEvents('openai-chat', toolStreamEvents(), model),
      'openai-responses': () => protocolEvents('openai-responses', toolStreamEvents(), model),
      'gemini-generate': () => geminiEvents(toolStreamEvents(), model),
      'anthropic-messages': () => protocolEvents('anthropic-messages', toolStreamEvents(), model),
    }

    for (const dialect of Object.keys(streams) as FixtureName[]) {
      const labels: string[] = []
      for await (const frame of streams[dialect]()) labels.push(streamEventLabel(dialect, frame))
      expect(labels).toEqual(expected[dialect])
    }
  })

  test('Anthropic text_end emits only the suffix missing from streamed deltas', async () => {
    const model: GatewayModelIdentity = { provider: 'deepseek', id: 'deepseek-v4-pro' }
    const message = { ...toolCompletion(), content: [{ type: 'text' as const, text: 'hello' }] }
    const events: ModelStreamEvent[] = [
      { type: 'start', partial: message },
      { type: 'text_start', contentIndex: 0, partial: message },
      { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: message },
      { type: 'text_end', contentIndex: 0, content: 'hello', partial: message },
      { type: 'done', reason: 'stop', message },
    ]
    const textDeltas: string[] = []
    for await (const frame of protocolEvents('anthropic-messages', events, model)) {
      if (frame.event !== 'content_block_delta') continue
      const data = frame.data as { delta?: { type?: string; text?: string } }
      if (data.delta?.type === 'text_delta') textDeltas.push(data.delta.text ?? '')
    }
    expect(textDeltas.join('')).toBe('hello')
  })
})

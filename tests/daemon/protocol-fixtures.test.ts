import { describe, expect, test } from 'bun:test'
import { parseAnthropicRequest } from '../../src/daemon/protocol/anthropicMessages.ts'
import { parseGeminiRequest } from '../../src/daemon/protocol/geminiGenerate.ts'
import { parseOpenAiChatRequest } from '../../src/daemon/protocol/openaiChat.ts'
import { parseResponsesRequest } from '../../src/daemon/protocol/openaiResponses.ts'
import type { GatewayChatRequest } from '../../src/daemon/types.ts'

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
})

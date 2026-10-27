import type { ModelCompletion, ModelInferenceContext, ModelPromptMessage } from '../../models/inference.ts'
import type { GatewayChatRequest, GatewayModelIdentity, GatewayRequestOptions } from '../types.ts'
import type { JsonRecord } from './common.ts'
import * as shared from './common.ts'

export function parseAnthropicRequest(value: unknown): GatewayChatRequest {
  const body = shared.record(value, 'request')
  shared.rejectUnknownRequestFields(body, [
    'model', 'max_tokens', 'system', 'messages', 'stream', 'temperature', 'top_p', 'top_k', 'stop_sequences',
    'tools', 'tool_choice', 'thinking', 'output_config', 'context_management', 'container', 'mcp_servers',
  ], 'Anthropic Messages')
  shared.rejectRequestedOptions(body, ['context_management', 'container', 'mcp_servers'], 'Anthropic Messages')
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 500) shared.fail('messages must contain between 1 and 500 entries.')
  const messages: ModelPromptMessage[] = []
  if (body.system !== undefined) messages.push(shared.systemMessage(shared.contentText(body.system, 'system')))
  for (let index = 0; index < body.messages.length; index++) {
    const item = shared.record(body.messages[index], `messages[${index}]`)
    shared.rejectUnknownFields(item, ['role', 'content'], `messages[${index}]`)
    const role = shared.string(item.role, `messages[${index}].role`)
    if (role !== 'user' && role !== 'assistant') shared.fail(`Unsupported Anthropic message role: ${role}.`)
    messages.push(...shared.anthropicContent(item.content, `messages[${index}].content`, role))
  }
  const tools = shared.parseTools(body.tools, 'anthropic')
  const context: ModelInferenceContext = { messages, ...(tools ? { tools } : {}) }
  const thinking = body.thinking === undefined ? undefined : shared.record(body.thinking, 'thinking')
  const anthropicThinkingDisplay = thinking?.type === 'adaptive' && (thinking.display === 'summarized' || thinking.display === 'omitted')
    ? thinking.display
    : undefined
  return {
    modelId: shared.modelField(body),
    context,
    options: shared.requestOptions(body, 'anthropic'),
    stream: shared.streamFlag(body),
    ...(anthropicThinkingDisplay ? { anthropicThinkingDisplay } : {}),
  }
}

export function serializeAnthropic(message: ModelCompletion, model: GatewayModelIdentity, thinkingDisplay: 'summarized' | 'omitted' = 'summarized'): JsonRecord {
  const content: JsonRecord[] = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking' && block.redacted) content.push({ type: 'redacted_thinking', data: block.signature ?? '' })
    else if (block.type === 'thinking' && thinkingDisplay === 'omitted') {
      if (block.signature) content.push({ type: 'thinking', thinking: '', signature: block.signature })
    } else if (block.type === 'thinking') content.push({ type: 'thinking', thinking: block.text, ...(block.signature ? { signature: block.signature } : {}) })
    else if (block.type === 'tool_call') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments })
  }
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: `${model.provider}/${model.id}`,
    content,
    stop_reason: message.stopReason === 'toolUse' ? 'tool_use' : message.stopReason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: message.usage.input, output_tokens: message.usage.output },
  }
}

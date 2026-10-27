import type { ModelCompletion, ModelImageBlock, ModelInferenceContext, ModelOutputBlock, ModelPromptMessage, ModelTextBlock, ModelToolCallBlock } from '../../models/inference.ts'
import type { GatewayChatRequest, GatewayModelIdentity, GatewayRequestOptions } from '../types.ts'
import type { JsonRecord } from './common.ts'
import * as shared from './common.ts'

export function parseOpenAiChatRequest(value: unknown): GatewayChatRequest {
  const body = shared.record(value, 'request')
  shared.rejectUnknownRequestFields(body, [
    'model', 'messages', 'tools', 'stream', 'n', 'parallel_tool_calls', 'max_completion_tokens', 'max_tokens',
    'temperature', 'top_p', 'top_k', 'stop', 'frequency_penalty', 'presence_penalty', 'reasoning_effort', 'tool_choice',
    'response_format', 'logprobs', 'top_logprobs', 'logit_bias', 'seed', 'functions', 'function_call',
  ], 'Chat Completions')
  if (body.n !== undefined && body.n !== 1) shared.fail('Only one Chat Completions choice (n=1) is supported.')
  if (body.parallel_tool_calls === false) shared.fail('parallel_tool_calls=false is not supported by this gateway.')
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 500) shared.fail('messages must contain between 1 and 500 entries.')
  const messages: ModelPromptMessage[] = []
  for (let index = 0; index < body.messages.length; index++) {
    const item = shared.record(body.messages[index], `messages[${index}]`)
    const role = shared.string(item.role, `messages[${index}].role`)
    const timestamp = Date.now()
    if (role === 'system' || role === 'developer') {
      shared.rejectUnknownFields(item, ['role', 'content', 'name'], `messages[${index}]`)
      if (item.name !== undefined) shared.string(item.name, `messages[${index}].name`)
      messages.push(shared.systemMessage(shared.contentText(item.content, `messages[${index}].content`)))
    } else if (role === 'user') {
      shared.rejectUnknownFields(item, ['role', 'content', 'name'], `messages[${index}]`)
      if (item.name !== undefined) shared.string(item.name, `messages[${index}].name`)
      messages.push({ role: 'user', content: shared.openAiContent(item.content, `messages[${index}].content`) as string | (ModelTextBlock | ModelImageBlock)[], timestamp })
    } else if (role === 'assistant') {
      shared.rejectUnknownFields(item, ['role', 'content', 'name', 'tool_calls', 'reasoning_content'], `messages[${index}]`)
      if (item.name !== undefined) shared.string(item.name, `messages[${index}].name`)
      if (item.reasoning_content !== undefined && typeof item.reasoning_content !== 'string') shared.fail(`messages[${index}].reasoning_content must be a string.`)
      const content = item.content === null || item.content === undefined
        ? []
        : typeof item.content === 'string'
          ? [{ type: 'text' as const, text: item.content }]
          : shared.openAiContent(item.content, `messages[${index}].content`) as (ModelTextBlock | ModelImageBlock)[]
      const assistantContent: ModelOutputBlock[] = content.map((block) => block.type === 'text' ? block : { type: 'text', text: '[image omitted from assistant history]' })
      if (item.tool_calls !== undefined && !Array.isArray(item.tool_calls)) shared.fail(`messages[${index}].tool_calls must be an array.`)
      if (Array.isArray(item.tool_calls)) {
        for (let callIndex = 0; callIndex < item.tool_calls.length; callIndex++) {
          const call = shared.record(item.tool_calls[callIndex], `messages[${index}].tool_calls[${callIndex}]`)
          shared.rejectUnknownFields(call, ['id', 'type', 'function'], `messages[${index}].tool_calls[${callIndex}]`)
          if (call.type !== 'function') shared.fail('Only function tool calls are supported.')
          const fn = shared.record(call.function, `messages[${index}].tool_calls[${callIndex}].function`)
          shared.rejectUnknownFields(fn, ['name', 'arguments'], `messages[${index}].tool_calls[${callIndex}].function`)
          assistantContent.push({ type: 'tool_call', id: shared.string(call.id, 'tool call id'), name: shared.string(fn.name, 'tool name'), arguments: shared.parseToolArguments(fn.arguments, 'tool arguments') })
        }
      }
      if (typeof item.reasoning_content === 'string') assistantContent.unshift({ type: 'thinking', text: item.reasoning_content })
      messages.push({ role: 'assistant', content: assistantContent, apiId: 'openai-completions', providerId: 'openai', modelId: 'gateway-input', usage: shared.emptyUsage(), stopReason: 'stop', timestamp })
    } else if (role === 'tool') {
      shared.rejectUnknownFields(item, ['role', 'tool_call_id', 'content', 'name'], `messages[${index}]`)
      const toolName = item.name === undefined ? 'tool' : shared.string(item.name, `messages[${index}].name`)
      messages.push({ role: 'tool_result', toolCallId: shared.string(item.tool_call_id, `messages[${index}].tool_call_id`), toolName, content: [{ type: 'text', text: shared.contentText(item.content, `messages[${index}].content`) }], isError: false, timestamp })
    } else {
      shared.fail(`Unsupported chat message role: ${role}.`)
    }
  }
  const tools = shared.parseTools(body.tools, 'openai')
  const context: ModelInferenceContext = { messages, ...(tools ? { tools } : {}) }
  return { modelId: shared.modelField(body), context, options: shared.requestOptions(body, 'openai'), stream: shared.streamFlag(body) }
}

export function serializeOpenAiChat(message: ModelCompletion, model: GatewayModelIdentity): JsonRecord {
  const calls = message.content.filter((block): block is ModelToolCallBlock => block.type === 'tool_call')
  const choices: JsonRecord = {
    index: 0,
    message: {
      role: 'assistant',
      content: shared.plainText(message) || null,
      ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
    },
    finish_reason: message.stopReason === 'toolUse' ? 'tool_calls' : message.stopReason === 'length' ? 'length' : 'stop',
  }
  const id = `chatcmpl_${crypto.randomUUID()}`
  return { id, object: 'chat.completion', created: Math.floor(message.timestamp / 1000), model: `${model.provider}/${model.id}`, choices: [choices], usage: shared.usageForOpenAi(message.usage) }
}

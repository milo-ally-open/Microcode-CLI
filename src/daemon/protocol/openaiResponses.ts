import type { ModelCompletion, ModelImageBlock, ModelInferenceContext, ModelPromptMessage, ModelTextBlock } from '../../models/inference.ts'
import type { GatewayChatRequest, GatewayModelIdentity, GatewayRequestOptions } from '../types.ts'
import type { JsonRecord } from './common.ts'
import * as shared from './common.ts'

function validateResponsesItemMetadata(item: JsonRecord, label: string): void {
  if (item.id !== undefined) shared.string(item.id, `${label}.id`)
  if (item.status !== undefined && item.status !== 'completed' && item.status !== 'in_progress' && item.status !== 'incomplete') {
    shared.fail(`${label}.status must be completed, in_progress, or incomplete.`)
  }
}

export function parseResponsesRequest(value: unknown): GatewayChatRequest {
  const body = shared.record(value, 'request')
  shared.rejectUnknownRequestFields(body, [
    'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'max_output_tokens',
    'temperature', 'reasoning', 'text', 'include', 'prompt_cache_key', 'client_metadata', 'store',
    'previous_response_id', 'max_tool_calls', 'prompt',
  ], 'Responses')
  if (body.store !== undefined && typeof body.store !== 'boolean') shared.fail('store must be a boolean.')
  const input = body.input
  if (typeof input !== 'string' && !Array.isArray(input)) shared.fail('input must be a string or array.')
  const messages: ModelPromptMessage[] = []
  if (body.instructions !== undefined) messages.push(shared.systemMessage(shared.contentText(body.instructions, 'instructions')))
  const calls = new Map<string, string>()
  const responsesToolNamespaces = new Map<string, { namespace: string; name: string }>()
  const additionalToolDeclarations: unknown[] = []
  const entries = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input
  if (entries.length > 500) shared.fail('input may contain at most 500 entries.')
  for (let index = 0; index < entries.length; index++) {
    const item = shared.record(entries[index], `input[${index}]`)
    if (item.type === 'additional_tools') {
      shared.rejectUnknownFields(item, ['type', 'role', 'tools'], `input[${index}]`)
      if (item.role !== undefined && item.role !== 'developer') shared.fail(`input[${index}].role must be developer for additional_tools.`)
      if (!Array.isArray(item.tools)) shared.fail(`input[${index}].tools must be an array.`)
      additionalToolDeclarations.push(...item.tools)
      if (additionalToolDeclarations.length > 128) shared.fail('At most 128 additional tools may be declared.')
    } else if (item.type === 'function_call') {
      shared.rejectUnknownFields(item, ['type', 'call_id', 'id', 'name', 'namespace', 'arguments', 'status'], `input[${index}]`)
      validateResponsesItemMetadata(item, `input[${index}]`)
      const id = shared.string(item.call_id ?? item.id, `input[${index}].call_id`)
      const name = shared.string(item.name, `input[${index}].name`)
      const namespace = item.namespace === undefined ? undefined : shared.string(item.namespace, `input[${index}].namespace`)
      const normalizedName = namespace ? `${namespace}__${name}` : name
      calls.set(id, normalizedName)
      messages.push({ role: 'assistant', content: [{ type: 'tool_call', id, name: normalizedName, arguments: shared.parseToolArguments(item.arguments ?? '{}', `input[${index}].arguments`) }], apiId: 'openai-responses', providerId: 'openai', modelId: 'gateway-input', usage: shared.emptyUsage(), stopReason: 'toolUse', timestamp: Date.now() })
    } else if (item.type === 'function_call_output') {
      shared.rejectUnknownFields(item, ['type', 'call_id', 'output'], `input[${index}]`)
      const id = shared.string(item.call_id, `input[${index}].call_id`)
      messages.push({ role: 'tool_result', toolCallId: id, toolName: calls.get(id) ?? 'tool', content: [{ type: 'text', text: shared.contentText(item.output, `input[${index}].output`) }], isError: false, timestamp: Date.now() })
    } else if (item.type === 'message' || item.type === undefined) {
      shared.rejectUnknownFields(item, ['type', 'id', 'status', 'role', 'content'], `input[${index}]`)
      validateResponsesItemMetadata(item, `input[${index}]`)
      const role = item.role === 'developer' ? 'system' : item.role
      if (role === 'system') messages.push(shared.systemMessage(shared.contentText(item.content, `input[${index}].content`)))
      else if (role === 'user') messages.push({ role: 'user', content: shared.openAiContent(item.content, `input[${index}].content`) as string | (ModelTextBlock | ModelImageBlock)[], timestamp: Date.now() })
      else if (role === 'assistant') {
        const text = shared.contentText(item.content, `input[${index}].content`)
        messages.push({ role: 'assistant', content: [{ type: 'text', text }], apiId: 'openai-responses', providerId: 'openai', modelId: 'gateway-input', usage: shared.emptyUsage(), stopReason: 'stop', timestamp: Date.now() })
      } else shared.fail(`Unsupported Responses input role: ${String(role)}.`)
    } else {
      shared.fail(`Unsupported Responses input item: ${String(item.type)}.`)
    }
  }
  const declaredTools = [
    ...(Array.isArray(body.tools) ? body.tools : body.tools === undefined ? [] : shared.fail('tools must be an array when provided.')),
    ...additionalToolDeclarations,
  ]
  const tools = shared.parseTools(declaredTools.length ? declaredTools : undefined, 'responses', responsesToolNamespaces)
  const context: ModelInferenceContext = { messages, ...(tools ? { tools } : {}) }
  return {
    modelId: shared.modelField(body), context, options: shared.requestOptions(body, 'responses'), stream: shared.streamFlag(body),
    ...(responsesToolNamespaces.size ? { responsesToolNamespaces } : {}),
  }
}

export function serializeResponses(
  message: ModelCompletion,
  model: GatewayModelIdentity,
  includeReasoningSummary = false,
  namespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
): JsonRecord {
  const output: JsonRecord[] = []
  const text = shared.plainText(message)
  let pendingText = ''
  const flushText = () => {
    if (!pendingText) return
    output.push({ type: 'message', id: `msg_${crypto.randomUUID()}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: pendingText, annotations: [] }] })
    pendingText = ''
  }
  for (const block of message.content) {
    if (block.type === 'text') pendingText += block.text
    else if (block.type === 'tool_call') {
      flushText()
      output.push({ type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: block.id, ...shared.responsesToolName(block.name, namespaces), arguments: JSON.stringify(block.arguments), status: 'completed' })
    } else if (block.type === 'thinking' && includeReasoningSummary && !block.redacted && block.text) {
      flushText()
      output.push({ type: 'reasoning', id: `rs_${crypto.randomUUID()}`, status: 'completed', summary: [{ type: 'summary_text', text: block.text }] })
    }
  }
  flushText()
  return {
    id: `resp_${crypto.randomUUID()}`,
    object: 'response',
    created_at: Math.floor(message.timestamp / 1000),
    status: 'completed',
    error: null,
    incomplete_details: message.stopReason === 'length' ? { reason: 'max_output_tokens' } : null,
    model: `${model.provider}/${model.id}`,
    output,
    output_text: text,
    usage: { input_tokens: message.usage.input, output_tokens: message.usage.output, total_tokens: message.usage.totalTokens },
  }
}

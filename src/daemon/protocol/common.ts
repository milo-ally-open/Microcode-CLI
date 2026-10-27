import type {
  ModelCompletion,
  ModelImageBlock,
  ModelOutputBlock,
  ModelPromptBlock,
  ModelPromptMessage,
  ModelTextBlock,
  ModelToolDefinition,
  ModelUsage,
} from '../../models/inference.ts'
import type { GatewayRequestOptions } from '../types.ts'

export type JsonRecord = Record<string, unknown>

export function fail(message: string, status = 400): never {
  throw new GatewayProtocolError(message, status)
}

export function rejectRequestedOptions(body: JsonRecord, fields: string[], dialect: string): void {
  const requested = fields.filter((field) => body[field] !== undefined && body[field] !== null)
  if (requested.length) fail(`${dialect} option(s) are not supported by this gateway: ${requested.join(', ')}.`)
}

export function rejectUnknownRequestFields(body: JsonRecord, allowedFields: readonly string[], dialect: string): void {
  rejectUnknownFields(body, allowedFields, `${dialect} request`)
}

export function rejectUnknownFields(value: JsonRecord, allowedFields: readonly string[], label: string): void {
  const allowed = new Set(allowedFields)
  const unknown = Object.keys(value).filter((field) => !allowed.has(field))
  if (unknown.length) fail(`${label} field(s) are not supported by this gateway: ${unknown.join(', ')}.`)
}

export class GatewayProtocolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'GatewayProtocolError'
  }
}

export function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`)
  return value as JsonRecord
}

export function string(value: unknown, label: string, optional = false): string {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string') fail(`${label} must be a string.`)
  return value
}

export function contentText(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) fail(`${label} must be text or an array of content blocks.`)
  return value.map((block, index) => {
    const item = record(block, `${label}[${index}]`)
    if (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') {
      rejectUnknownFields(item, item.type === 'output_text' ? ['type', 'text', 'annotations'] : ['type', 'text'], `${label}[${index}]`)
      if (item.annotations !== undefined && (!Array.isArray(item.annotations) || item.annotations.length > 0)) {
        fail(`${label}[${index}].annotations must be an empty array.`)
      }
      return string(item.text, `${label}[${index}].text`)
    }
    fail(`Unsupported content block in ${label}: ${String(item.type)}.`)
  }).join('')
}

export function imageFromDataUrl(url: unknown, label: string): ModelImageBlock {
  if (typeof url !== 'string') fail(`${label} must be a data URL.`)
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/i.exec(url)
  if (!match) fail(`${label} must be a base64 PNG, JPEG, GIF, or WebP data URL; remote image URLs are not fetched.`)
  return { type: 'image', mimeType: match[1]!.toLowerCase(), data: match[2]! }
}

export function openAiContent(value: unknown, label: string): string | (ModelTextBlock | ModelImageBlock)[] {
  if (typeof value === 'string' || value === null) return value ?? ''
  if (!Array.isArray(value)) fail(`${label} must be a string or content array.`)
  return value.map((raw, index) => {
    const block = record(raw, `${label}[${index}]`)
    if (block.type === 'text' || block.type === 'input_text') {
      rejectUnknownFields(block, ['type', 'text'], `${label}[${index}]`)
      return { type: 'text' as const, text: string(block.text, `${label}[${index}].text`) }
    }
    if (block.type === 'image_url') {
      rejectUnknownFields(block, ['type', 'image_url'], `${label}[${index}]`)
      const imageUrl = typeof block.image_url === 'string'
        ? undefined
        : record(block.image_url, `${label}[${index}].image_url`)
      if (imageUrl) {
        rejectUnknownFields(imageUrl, ['url', 'detail'], `${label}[${index}].image_url`)
        if (imageUrl.detail !== undefined && !['auto', 'low', 'high'].includes(String(imageUrl.detail))) {
          fail(`${label}[${index}].image_url.detail must be auto, low, or high.`)
        }
      }
      const image = imageUrl ? imageUrl.url : block.image_url
      return imageFromDataUrl(image, `${label}[${index}].image_url`)
    }
    fail(`Unsupported content block in ${label}: ${String(block.type)}.`)
  })
}

export function anthropicContent(value: unknown, label: string, role: 'user' | 'assistant'): ModelPromptMessage[] {
  const blocks = typeof value === 'string' ? [{ type: 'text', text: value }] : value
  if (!Array.isArray(blocks)) fail(`${label} must be text or an array of content blocks.`)
  const messages: ModelPromptMessage[] = []
  let ordinary: ModelPromptBlock[] = []
  const flush = () => {
    if (ordinary.length === 0) return
    if (role === 'user') messages.push({ role, content: ordinary as Array<ModelTextBlock | ModelImageBlock>, timestamp: Date.now() })
    else messages.push({
      role,
      content: ordinary as ModelOutputBlock[],
      apiId: 'anthropic-messages',
      providerId: 'anthropic',
      modelId: 'gateway-input',
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    })
    ordinary = []
  }
  for (let index = 0; index < blocks.length; index++) {
    const block = record(blocks[index], `${label}[${index}]`)
    if (block.type === 'text') {
      rejectUnknownFields(block, ['type', 'text'], `${label}[${index}]`)
      ordinary.push({ type: 'text', text: string(block.text, `${label}[${index}].text`) })
    } else if (block.type === 'image' && role === 'user') {
      rejectUnknownFields(block, ['type', 'source'], `${label}[${index}]`)
      const source = record(block.source, `${label}[${index}].source`)
      rejectUnknownFields(source, ['type', 'media_type', 'data'], `${label}[${index}].source`)
      if (source.type !== 'base64') fail('Remote Anthropic image sources are not fetched by the gateway.')
      const mimeType = string(source.media_type, `${label}[${index}].source.media_type`)
      if (!/^image\/(png|jpeg|gif|webp)$/i.test(mimeType)) fail('Unsupported image media type.')
      ordinary.push({ type: 'image', mimeType: mimeType.toLowerCase(), data: string(source.data, `${label}[${index}].source.data`) })
    } else if (block.type === 'thinking' && role === 'assistant') {
      rejectUnknownFields(block, ['type', 'thinking', 'signature'], `${label}[${index}]`)
      if (block.signature !== undefined && typeof block.signature !== 'string') fail(`${label}[${index}].signature must be a string.`)
      ordinary.push({ type: 'thinking', text: string(block.thinking, `${label}[${index}].thinking`), ...(block.signature === undefined ? {} : { signature: string(block.signature, `${label}[${index}].signature`) }) })
    } else if (block.type === 'redacted_thinking' && role === 'assistant') {
      rejectUnknownFields(block, ['type', 'data'], `${label}[${index}]`)
      ordinary.push({ type: 'thinking', text: '', signature: string(block.data, `${label}[${index}].data`), redacted: true })
    } else if (block.type === 'tool_use' && role === 'assistant') {
      rejectUnknownFields(block, ['type', 'id', 'name', 'input'], `${label}[${index}]`)
      const input = record(block.input ?? {}, `${label}[${index}].input`)
      ordinary.push({ type: 'tool_call', id: string(block.id, `${label}[${index}].id`), name: string(block.name, `${label}[${index}].name`), arguments: input })
    } else if (block.type === 'tool_result' && role === 'user') {
      rejectUnknownFields(block, ['type', 'tool_use_id', 'content', 'is_error', 'name'], `${label}[${index}]`)
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') fail(`${label}[${index}].is_error must be a boolean.`)
      flush()
      const resultContent = typeof block.content === 'string'
        ? [{ type: 'text' as const, text: block.content }]
        : Array.isArray(block.content)
          ? block.content.map((part, partIndex) => {
              const item = record(part, `${label}[${index}].content[${partIndex}]`)
              if (item.type === 'text') {
                rejectUnknownFields(item, ['type', 'text'], `${label}[${index}].content[${partIndex}]`)
                return { type: 'text' as const, text: string(item.text, `${label}[${index}].content[${partIndex}].text`) }
              }
              if (item.type === 'image') {
                rejectUnknownFields(item, ['type', 'source'], `${label}[${index}].content[${partIndex}]`)
                const source = record(item.source, `${label}[${index}].content[${partIndex}].source`)
                rejectUnknownFields(source, ['type', 'media_type', 'data'], `${label}[${index}].content[${partIndex}].source`)
                if (source.type !== 'base64') fail('Remote Anthropic tool-result images are not fetched by the gateway.')
                const mimeType = string(source.media_type, 'tool-result media_type')
                if (!/^image\/(png|jpeg|gif|webp)$/i.test(mimeType)) fail('Unsupported tool-result image media type.')
                return { type: 'image' as const, mimeType: mimeType.toLowerCase(), data: string(source.data, 'tool-result image data') }
              }
              fail(`Unsupported tool result block: ${String(item.type)}.`)
            })
          : fail(`${label}[${index}].content must be text or content blocks.`)
      messages.push({
        role: 'tool_result',
        toolCallId: string(block.tool_use_id, `${label}[${index}].tool_use_id`),
        toolName: block.name === undefined ? 'tool' : string(block.name, `${label}[${index}].name`),
        content: resultContent,
        isError: block.is_error === true,
        timestamp: Date.now(),
      })
    } else {
      fail(`Unsupported ${role} content block: ${String(block.type)}.`)
    }
  }
  flush()
  return messages
}

export function parseToolArguments(value: unknown, label: string): Record<string, unknown> {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { fail(`${label} must contain valid JSON.`) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} must decode to a JSON object.`)
  return parsed as Record<string, unknown>
}

export function parseTools(
  value: unknown,
  dialect: 'openai' | 'anthropic' | 'responses',
  responsesToolNamespaces?: Map<string, { namespace: string; name: string }>,
): ModelToolDefinition[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('tools must be an array.')
  if (value.length > 128) fail('At most 128 tools may be declared.')
  let totalSchemaBytes = 0
  let toolCount = 0
  const names = new Set<string>()
  const tools: ModelToolDefinition[] = []
  const strictSampling = (value: unknown, label: string): ModelToolDefinition['constrainedSampling'] => {
    if (value === undefined || value === false) return undefined
    if (value !== true) fail(`${label} must be a boolean.`)
    return { type: 'json_schema', strict: 'require' }
  }
  const parameters = (schema: unknown, label: string): Record<string, unknown> => {
    const parsed = record(schema ?? { type: 'object' }, label)
    const size = Buffer.byteLength(JSON.stringify(parsed), 'utf8')
    if (size > 64 * 1024) fail(`${label} exceeds the 65536-byte per-tool schema limit.`, 413)
    totalSchemaBytes += size
    if (totalSchemaBytes > 256 * 1024) fail('Tool schemas exceed the 262144-byte aggregate limit.', 413)
    return parsed
  }
  const addTool = (name: string, description: unknown, schema: unknown, label: string, strict?: unknown, strictLabel?: string) => {
    if (names.has(name)) fail(`Tool name "${name}" is duplicated after Responses namespace normalization.`)
    names.add(name)
    const constrainedSampling = strictSampling(strict, strictLabel ?? `${label}.strict`)
    tools.push({ name, description: typeof description === 'string' ? description : '', parameters: parameters(schema, label), ...(constrainedSampling ? { constrainedSampling } : {}) })
    toolCount++
    if (toolCount > 128) fail('At most 128 tools may be declared.')
  }
  for (let index = 0; index < value.length; index++) {
    const item = record(value[index], `tools[${index}]`)
    if (dialect === 'openai') {
      rejectUnknownFields(item, ['type', 'function'], `tools[${index}]`)
      if (item.type !== 'function') fail('Only function tools are supported.')
      const fn = record(item.function, `tools[${index}].function`)
      rejectUnknownFields(fn, ['name', 'description', 'parameters', 'strict'], `tools[${index}].function`)
      addTool(string(fn.name, `tools[${index}].function.name`), fn.description, fn.parameters, `tools[${index}].function.parameters`, fn.strict, `tools[${index}].function.strict`)
      continue
    }
    if (dialect === 'responses') {
      if (item.type === 'function') {
        rejectUnknownFields(item, ['type', 'name', 'description', 'parameters', 'strict'], `tools[${index}]`)
        addTool(string(item.name, `tools[${index}].name`), item.description, item.parameters, `tools[${index}].parameters`, item.strict, `tools[${index}].strict`)
        continue
      }
      if (item.type === 'namespace') {
        rejectUnknownFields(item, ['type', 'name', 'description', 'tools'], `tools[${index}]`)
        const namespace = string(item.name, `tools[${index}].name`)
        if (!Array.isArray(item.tools)) fail(`tools[${index}].tools must be an array.`)
        for (let nestedIndex = 0; nestedIndex < item.tools.length; nestedIndex++) {
          const nested = record(item.tools[nestedIndex], `tools[${index}].tools[${nestedIndex}]`)
          rejectUnknownFields(nested, ['type', 'name', 'description', 'parameters', 'strict'], `tools[${index}].tools[${nestedIndex}]`)
          if (nested.type !== 'function') fail(`Unsupported Responses namespace tool type "${String(nested.type)}"; only caller-owned function tools are supported.`)
          const name = string(nested.name, `tools[${index}].tools[${nestedIndex}].name`)
          const normalizedName = `${namespace}__${name}`
          responsesToolNamespaces?.set(normalizedName, { namespace, name })
          addTool(normalizedName, nested.description, nested.parameters, `tools[${index}].tools[${nestedIndex}].parameters`, nested.strict, `tools[${index}].tools[${nestedIndex}].strict`)
        }
        continue
      }
      // Codex advertises this disabled hosted tool even when search is off.
      // Accept only the explicit disabled marker; enabled/extended variants remain unsupported.
      if (item.type === 'web_search' && item.external_web_access === false && Object.keys(item).every((key) => key === 'type' || key === 'external_web_access')) continue
      const unsupportedType = typeof item.type === 'string' ? item.type.slice(0, 80) : 'missing type'
      fail(`Unsupported Responses tool type "${unsupportedType}"; hosted tools are not executed by this gateway.`)
    }
    rejectUnknownFields(item, ['name', 'description', 'input_schema'], `tools[${index}]`)
    addTool(string(item.name, `tools[${index}].name`), item.description, item.input_schema, `tools[${index}].input_schema`)
  }
  return tools
}

export function emptyUsage(): ModelUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

export function requestOptions(body: JsonRecord, dialect: 'openai' | 'anthropic' | 'responses' | 'gemini'): GatewayRequestOptions {
  let maxTokens: unknown
  let reasoning: GatewayRequestOptions['reasoning']
  let reasoningSummary: GatewayRequestOptions['reasoningSummary']
  let temperature: unknown
  let toolChoice: GatewayRequestOptions['toolChoice']
  let parallelToolCalls: GatewayRequestOptions['parallelToolCalls']
  let samplingParams: Record<string, unknown> | undefined
  let adaptiveThinking = false

  if (dialect === 'openai') {
    rejectRequestedOptions(body, ['response_format', 'logprobs', 'top_logprobs', 'logit_bias', 'seed', 'functions', 'function_call'], 'Chat Completions')
    maxTokens = body.max_completion_tokens ?? body.max_tokens
    temperature = body.temperature
    if (body.top_p !== undefined || body.top_k !== undefined || body.stop !== undefined || body.frequency_penalty !== undefined || body.presence_penalty !== undefined) {
      samplingParams = Object.fromEntries(['top_p', 'top_k', 'stop', 'frequency_penalty', 'presence_penalty'].filter((key) => body[key] !== undefined).map((key) => [key, body[key]]))
    }
    if (body.reasoning_effort !== undefined) {
      if (body.reasoning_effort === 'minimal' || body.reasoning_effort === 'low' || body.reasoning_effort === 'medium' || body.reasoning_effort === 'high' || body.reasoning_effort === 'xhigh' || body.reasoning_effort === 'max') reasoning = body.reasoning_effort
      else if (body.reasoning_effort !== 'none') fail('Unsupported Chat Completions reasoning_effort.')
    }
    if (body.tool_choice === 'none') toolChoice = 'none'
    else if (body.tool_choice === 'auto' || body.tool_choice === undefined) toolChoice = 'auto'
    else fail('Forced function tool selection is not supported by this gateway.')
  } else if (dialect === 'anthropic') {
    maxTokens = body.max_tokens
    temperature = body.temperature
    if (body.top_p !== undefined || body.top_k !== undefined || body.stop_sequences !== undefined) {
      samplingParams = Object.fromEntries([['top_p', body.top_p], ['top_k', body.top_k], ['stop', body.stop_sequences]].filter(([, value]) => value !== undefined))
    }
    if (body.thinking !== undefined) {
      const thinking = record(body.thinking, 'thinking')
      rejectUnknownFields(thinking, ['type', 'display', 'budget_tokens'], 'thinking')
      if (thinking.budget_tokens !== undefined && thinking.type !== 'enabled') {
        fail('Anthropic thinking.budget_tokens is only valid with fixed-budget thinking, which is not supported by this gateway.')
      }
      if (thinking.display !== undefined && thinking.display !== null && thinking.display !== 'summarized' && thinking.display !== 'omitted') {
        fail('Unsupported Anthropic thinking.display value.')
      }
      if (thinking.type === 'adaptive') {
        adaptiveThinking = true
        const outputConfig = body.output_config === undefined ? undefined : record(body.output_config, 'output_config')
        if (outputConfig) rejectUnknownFields(outputConfig, ['effort'], 'output_config')
        const effort = outputConfig?.effort ?? 'medium'
        if (effort !== 'minimal' && effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'max') fail('Unsupported Anthropic output_config.effort.')
        reasoning = effort
      } else if (thinking.type === 'enabled') {
        fail('Anthropic fixed-budget thinking is not supported by this gateway reasoning contract.')
      }
      else if (thinking.type === 'disabled') {
        if (thinking.display !== undefined && thinking.display !== null) fail('Anthropic thinking.display requires adaptive thinking.')
      } else fail('Unsupported Anthropic thinking mode.')
    }
    if (body.output_config !== undefined && !adaptiveThinking) {
      fail('Anthropic output_config is supported only with adaptive thinking.')
    }
    const choice = body.tool_choice
    if (choice === undefined) toolChoice = 'auto'
    else {
      const choiceRecord = record(choice, 'tool_choice')
      rejectUnknownFields(choiceRecord, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice')
      if (choiceRecord.name !== undefined) string(choiceRecord.name, 'tool_choice.name')
      if (choiceRecord.disable_parallel_tool_use !== undefined && typeof choiceRecord.disable_parallel_tool_use !== 'boolean') {
        fail('tool_choice.disable_parallel_tool_use must be a boolean.')
      }
      if (choiceRecord.name !== undefined && choiceRecord.type !== 'tool') {
        fail('tool_choice.name is only valid for forced tool selection, which is not supported by this gateway.')
      }
      if (choiceRecord.disable_parallel_tool_use === true) parallelToolCalls = false
      if (choiceRecord.type === 'auto') toolChoice = 'auto'
      else if (choiceRecord.type === 'none') toolChoice = 'none'
      else fail('Forced Anthropic tool selection is not supported by this gateway.')
    }
  } else if (dialect === 'gemini') {
    const config = body.generationConfig === undefined ? {} : record(body.generationConfig, 'generationConfig')
    const supported = new Set(['candidateCount', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'stopSequences', 'frequencyPenalty', 'presencePenalty', 'responseMimeType'])
    const unsupported = Object.keys(config).filter((key) => !supported.has(key))
    if (unsupported.length) fail(`Gemini generationConfig field(s) are not supported: ${unsupported.join(', ')}.`)
    if (config.candidateCount !== undefined && config.candidateCount !== 1) fail('Only one Gemini candidate is supported.')
    if (config.responseMimeType !== undefined && config.responseMimeType !== 'text/plain') fail('Only Gemini responseMimeType="text/plain" is supported.')
    maxTokens = config.maxOutputTokens
    temperature = config.temperature
    if (config.topP !== undefined || config.topK !== undefined || config.stopSequences !== undefined || config.frequencyPenalty !== undefined || config.presencePenalty !== undefined) {
      samplingParams = Object.fromEntries([
        ['top_p', config.topP],
        ['top_k', config.topK],
        ['stop', config.stopSequences],
        ['frequency_penalty', config.frequencyPenalty],
        ['presence_penalty', config.presencePenalty],
      ].filter(([, value]) => value !== undefined))
    }
    const toolConfig = body.toolConfig === undefined ? undefined : record(body.toolConfig, 'toolConfig')
    if (toolConfig) rejectUnknownFields(toolConfig, ['functionCallingConfig'], 'toolConfig')
    const functionConfig = toolConfig?.functionCallingConfig === undefined
      ? undefined
      : record(toolConfig.functionCallingConfig, 'toolConfig.functionCallingConfig')
    if (functionConfig) rejectUnknownFields(functionConfig, ['mode'], 'toolConfig.functionCallingConfig')
    const mode = functionConfig?.mode
    if (mode === undefined || mode === 'AUTO') toolChoice = 'auto'
    else if (mode === 'NONE') toolChoice = 'none'
    else fail('Gemini functionCallingConfig.mode must be AUTO or NONE.')
  } else {
    rejectRequestedOptions(body, ['previous_response_id', 'max_tool_calls', 'prompt'], 'Responses')
    if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls must be a boolean.')
    parallelToolCalls = body.parallel_tool_calls as boolean | undefined
    if (body.text !== undefined) {
      const text = record(body.text, 'text')
      rejectUnknownFields(text, ['verbosity'], 'text')
      if (text.verbosity !== undefined && text.verbosity !== 'low') fail('Only Responses text.verbosity="low" is supported by the normalized runtime.')
    }
    if (body.include !== undefined) {
      if (!Array.isArray(body.include) || body.include.some((item) => typeof item !== 'string')) fail('Responses include must be an array of strings.')
      const unsupported = body.include.filter((item) => item !== 'reasoning.encrypted_content')
      if (unsupported.length) fail(`Responses include field(s) are not supported: ${unsupported.join(', ')}.`)
      // Encrypted reasoning payloads are deliberately not produced or exposed by this gateway.
    }
    if (body.prompt_cache_key !== undefined && (typeof body.prompt_cache_key !== 'string' || body.prompt_cache_key.length > 1024)) fail('prompt_cache_key must be a string no longer than 1024 characters.')
    if (body.client_metadata !== undefined) record(body.client_metadata, 'client_metadata')
    if (body.store === true) fail('Responses stored conversation state is not supported; send the full input on each request.')
    maxTokens = body.max_output_tokens
    temperature = body.temperature
    const reasoningValue = body.reasoning
    if (reasoningValue !== undefined) {
      const reasoningObject = record(reasoningValue, 'reasoning')
      rejectUnknownFields(reasoningObject, ['effort', 'context', 'summary'], 'reasoning')
      const effort = reasoningObject.effort
      if (reasoningObject.context !== undefined && reasoningObject.context !== 'auto') fail('Only Responses reasoning.context="auto" is supported by the normalized runtime.')
      if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') reasoning = effort
      else if (effort !== undefined && effort !== 'none') fail('Unsupported Responses reasoning effort.')
      const summary = reasoningObject.summary
      if (summary === 'auto' || summary === 'concise' || summary === 'detailed') reasoningSummary = summary
      else if (summary === 'none') reasoningSummary = undefined
      else if (summary !== undefined && summary !== null) fail('Unsupported Responses reasoning.summary value.')
    }
    if (body.tool_choice === undefined || body.tool_choice === 'auto') toolChoice = 'auto'
    else if (body.tool_choice === 'none') toolChoice = 'none'
    else fail('Forced Responses tool selection is not supported by this gateway.')
  }

  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > 131072)) fail('Output token limit must be an integer between 1 and 131072.')
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) fail('temperature must be a number between 0 and 2.')
  if (samplingParams?.top_p !== undefined && (typeof samplingParams.top_p !== 'number' || samplingParams.top_p < 0 || samplingParams.top_p > 1)) fail('top_p must be a number between 0 and 1.')
  if (samplingParams?.top_k !== undefined && (!Number.isInteger(samplingParams.top_k) || (samplingParams.top_k as number) < 1)) fail('top_k must be a positive integer.')
  const stop = samplingParams?.stop
  if (stop !== undefined && !(typeof stop === 'string' || (Array.isArray(stop) && stop.every((item) => typeof item === 'string')))) fail('stop/stop_sequences must be a string or an array of strings.')
  for (const field of ['frequency_penalty', 'presence_penalty'] as const) {
    const value = samplingParams?.[field]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < -2 || value > 2)) fail(`${field} must be a number between -2 and 2.`)
  }
  return {
    ...(maxTokens === undefined ? {} : { maxTokens: maxTokens as number }),
    ...(temperature === undefined ? {} : { temperature: temperature as number }),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(samplingParams ? { samplingParams } : {}),
  }
}

export function geminiText(partsValue: unknown, label: string): string {
  if (!Array.isArray(partsValue) || partsValue.length === 0) fail(`${label} must be a non-empty parts array.`)
  return partsValue.map((part, index) => {
    const item = record(part, `${label}[${index}]`)
    rejectUnknownFields(item, ['text'], `${label}[${index}]`)
    return string(item.text, `${label}[${index}].text`)
  }).join('')
}

export function parseGeminiTools(value: unknown): ModelToolDefinition[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('tools must be an array.')
  const tools: ModelToolDefinition[] = []
  const names = new Set<string>()
  let totalSchemaBytes = 0
  for (let index = 0; index < value.length; index++) {
    const item = record(value[index], `tools[${index}]`)
    if (Object.keys(item).some((key) => key !== 'functionDeclarations')) fail('Only Gemini functionDeclarations tools are supported.')
    if (!Array.isArray(item.functionDeclarations)) fail(`tools[${index}].functionDeclarations must be an array.`)
    for (let declarationIndex = 0; declarationIndex < item.functionDeclarations.length; declarationIndex++) {
      const declaration = record(item.functionDeclarations[declarationIndex], `tools[${index}].functionDeclarations[${declarationIndex}]`)
      if (Object.keys(declaration).some((key) => !['name', 'description', 'parameters'].includes(key))) {
        fail(`Unsupported Gemini function declaration field in tools[${index}].functionDeclarations[${declarationIndex}].`)
      }
      const name = string(declaration.name, `tools[${index}].functionDeclarations[${declarationIndex}].name`)
      if (names.has(name)) fail(`Tool name "${name}" is duplicated.`)
      names.add(name)
      const parameters = record(declaration.parameters ?? { type: 'object' }, `tools[${index}].functionDeclarations[${declarationIndex}].parameters`)
      if (declaration.description !== undefined && typeof declaration.description !== 'string') {
        fail(`tools[${index}].functionDeclarations[${declarationIndex}].description must be a string.`)
      }
      totalSchemaBytes += Buffer.byteLength(JSON.stringify(parameters), 'utf8')
      if (Buffer.byteLength(JSON.stringify(parameters), 'utf8') > 64 * 1024) fail('A Gemini function schema exceeds the 65536-byte per-tool limit.', 413)
      if (totalSchemaBytes > 256 * 1024) fail('Gemini function schemas exceed the 262144-byte aggregate limit.', 413)
      tools.push({ name, description: typeof declaration.description === 'string' ? declaration.description : '', parameters })
      if (tools.length > 128) fail('At most 128 Gemini function declarations may be used.')
    }
  }
  return tools
}

export function streamFlag(body: JsonRecord): boolean {
  if (body.stream === undefined) return false
  if (typeof body.stream !== 'boolean') fail('stream must be a boolean.')
  return body.stream
}

export function modelField(body: JsonRecord): string {
  const model = string(body.model, 'model')
  if (!model.trim()) fail('model must not be empty.')
  return model
}

export function systemMessage(content: string): ModelPromptMessage {
  return { role: 'system', content, timestamp: Date.now() }
}

export function plainText(message: ModelCompletion): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

export function usageForOpenAi(usage: ModelUsage) {
  return { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.totalTokens }
}

export function responsesToolName(name: string, namespaces?: ReadonlyMap<string, { namespace: string; name: string }>): JsonRecord {
  const mapped = namespaces?.get(name)
  return mapped ? { namespace: mapped.namespace, name: mapped.name } : { name }
}

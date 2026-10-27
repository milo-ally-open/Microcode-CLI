import type { ModelCompletion, ModelImageBlock, ModelInferenceContext, ModelOutputBlock, ModelPromptMessage, ModelTextBlock } from '../../models/inference.ts'
import type { GatewayChatRequest, GatewayModelIdentity, GatewayRequestOptions } from '../types.ts'
import type { JsonRecord } from './common.ts'
import * as shared from './common.ts'

export function parseGeminiRequest(value: unknown, modelId: string, stream = false): GatewayChatRequest {
  const body = shared.record(value, 'request')
  const allowed = new Set(['contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig'])
  const unsupported = Object.keys(body).filter((key) => !allowed.has(key))
  if (unsupported.length) shared.fail(`Gemini request field(s) are not supported: ${unsupported.join(', ')}.`)
  if (!modelId.trim()) shared.fail('Gemini model route must include a model ID.')
  if (!Array.isArray(body.contents) || body.contents.length === 0 || body.contents.length > 500) shared.fail('contents must contain between 1 and 500 entries.')

  const messages: ModelPromptMessage[] = []
  if (body.systemInstruction !== undefined) {
    const system = shared.record(body.systemInstruction, 'systemInstruction')
    if (Object.keys(system).some((key) => key !== 'parts')) shared.fail('Unsupported Gemini systemInstruction field.')
    messages.push(shared.systemMessage(shared.geminiText(system.parts, 'systemInstruction.parts')))
  }

  const callsByName = new Map<string, string>()
  for (let index = 0; index < body.contents.length; index++) {
    const content = shared.record(body.contents[index], `contents[${index}]`)
    if (Object.keys(content).some((key) => key !== 'role' && key !== 'parts')) shared.fail(`Unsupported Gemini contents[${index}] field.`)
    const role = shared.string(content.role, `contents[${index}].role`)
    if (role !== 'user' && role !== 'model') shared.fail(`Unsupported Gemini content role: ${role}.`)
    if (!Array.isArray(content.parts) || content.parts.length === 0) shared.fail(`contents[${index}].parts must be a non-empty array.`)

    if (role === 'user') {
      let ordinary: Array<ModelTextBlock | ModelImageBlock> = []
      const flush = () => {
        if (ordinary.length === 0) return
        messages.push({ role: 'user', content: ordinary, timestamp: Date.now() })
        ordinary = []
      }
      for (let partIndex = 0; partIndex < content.parts.length; partIndex++) {
        const part = shared.record(content.parts[partIndex], `contents[${index}].parts[${partIndex}]`)
        if (typeof part.text === 'string' && Object.keys(part).every((key) => key === 'text')) {
          ordinary.push({ type: 'text', text: part.text })
        } else if (part.inlineData !== undefined && Object.keys(part).every((key) => key === 'inlineData')) {
          const inlineData = shared.record(part.inlineData, `contents[${index}].parts[${partIndex}].inlineData`)
          if (Object.keys(inlineData).some((key) => key !== 'mimeType' && key !== 'data')) shared.fail('Unsupported Gemini inlineData field.')
          const mimeType = shared.string(inlineData.mimeType, `contents[${index}].parts[${partIndex}].inlineData.mimeType`)
          const data = shared.string(inlineData.data, `contents[${index}].parts[${partIndex}].inlineData.data`)
          if (!/^image\/(png|jpeg|gif|webp)$/i.test(mimeType)) shared.fail('Gemini inlineData supports PNG, JPEG, GIF, or WebP images only.')
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) shared.fail('Gemini inlineData.data must be base64 encoded.')
          ordinary.push({ type: 'image', mimeType: mimeType.toLowerCase(), data })
        } else if (part.functionResponse !== undefined && Object.keys(part).every((key) => key === 'functionResponse')) {
          flush()
          const response = shared.record(part.functionResponse, `contents[${index}].parts[${partIndex}].functionResponse`)
          if (Object.keys(response).some((key) => !['name', 'id', 'response'].includes(key))) shared.fail('Unsupported Gemini functionResponse field.')
          const name = shared.string(response.name, `contents[${index}].parts[${partIndex}].functionResponse.name`)
          const callId = typeof response.id === 'string' ? response.id : callsByName.get(name) ?? `call_${crypto.randomUUID()}`
          const result = response.response === undefined ? {} : response.response
          messages.push({
            role: 'tool_result',
            toolCallId: callId,
            toolName: name,
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
            isError: false,
            timestamp: Date.now(),
          })
        } else {
          shared.fail(`Unsupported Gemini user part in contents[${index}].parts[${partIndex}].`)
        }
      }
      flush()
      continue
    }

    const assistantContent: ModelOutputBlock[] = []
    for (let partIndex = 0; partIndex < content.parts.length; partIndex++) {
      const part = shared.record(content.parts[partIndex], `contents[${index}].parts[${partIndex}]`)
      if (typeof part.text === 'string' && Object.keys(part).every((key) => key === 'text')) {
        assistantContent.push({ type: 'text', text: part.text })
      } else if (part.functionCall !== undefined && Object.keys(part).every((key) => key === 'functionCall')) {
        const call = shared.record(part.functionCall, `contents[${index}].parts[${partIndex}].functionCall`)
        if (Object.keys(call).some((key) => !['name', 'id', 'args'].includes(key))) shared.fail('Unsupported Gemini functionCall field.')
        const name = shared.string(call.name, `contents[${index}].parts[${partIndex}].functionCall.name`)
        const callId = typeof call.id === 'string' ? call.id : `call_${crypto.randomUUID()}`
        callsByName.set(name, callId)
        assistantContent.push({
          type: 'tool_call',
          id: callId,
          name,
          arguments: shared.parseToolArguments(call.args ?? {}, `contents[${index}].parts[${partIndex}].functionCall.args`),
        })
      } else {
        shared.fail(`Unsupported Gemini model part in contents[${index}].parts[${partIndex}].`)
      }
    }
    messages.push({
      role: 'assistant',
      content: assistantContent,
      apiId: 'google-generative-ai',
      providerId: 'gateway-input',
      modelId: 'gateway-input',
      usage: shared.emptyUsage(),
      stopReason: assistantContent.some((part) => part.type === 'tool_call') ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    })
  }

  const tools = shared.parseGeminiTools(body.tools)
  const context: ModelInferenceContext = { messages, ...(tools ? { tools } : {}) }
  return { modelId, context, options: shared.requestOptions(body, 'gemini'), stream }
}

export function serializeGemini(message: ModelCompletion, model: GatewayModelIdentity): JsonRecord {
  const parts: JsonRecord[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text) parts.push({ text: block.text })
    }
    else if (block.type === 'tool_call') {
      parts.push({ functionCall: { id: block.id, name: block.name, args: block.arguments } })
    } else if (block.type !== 'thinking') shared.fail('Gemini response contains an unsupported output modality.', 502)
  }
  return {
    candidates: [{
      index: 0,
      content: { role: 'model', parts },
      finishReason: message.stopReason === 'length' ? 'MAX_TOKENS' : 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: message.usage.input,
      candidatesTokenCount: message.usage.output,
      totalTokenCount: message.usage.totalTokens,
    },
    modelVersion: model.id,
    responseId: message.responseId ?? `gemini_${crypto.randomUUID()}`,
  }
}

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai'
import type {
  ModelCompletion,
  ModelImageBlock,
  ModelInferenceContext,
  ModelOutputBlock,
  ModelPromptBlock,
  ModelPromptMessage,
  ModelRuntimeDescriptor,
  ModelStreamEvent,
  ModelTextBlock,
  ModelThinkingBlock,
  ModelToolCallBlock,
  ModelToolDefinition,
  ModelUsage,
} from '../../models/inference.ts'

function toModelTool(tool: Tool): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
  }
}

function toPiTool(tool: ModelToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool['parameters'],
    ...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling as Tool['constrainedSampling'] }),
  }
}

function toModelBlock(block: TextContent | ThinkingContent | ToolCall): ModelOutputBlock {
  if (block.type === 'text') return { type: 'text', text: block.text, ...(block.textSignature ? { signature: block.textSignature } : {}) }
  if (block.type === 'thinking') return {
    type: 'thinking',
    text: block.thinking,
    ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}),
    ...(block.redacted ? { redacted: true } : {}),
  }
  return {
    type: 'tool_call',
    id: block.id,
    name: block.name,
    arguments: block.arguments,
    ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
    ...(block.namespace ? { namespace: block.namespace } : {}),
  }
}

function toPiOutputBlock(block: ModelOutputBlock): TextContent | ThinkingContent | ToolCall {
  if (block.type === 'text') return { type: 'text', text: block.text, ...(block.signature ? { textSignature: block.signature } : {}) }
  if (block.type === 'thinking') return {
    type: 'thinking',
    thinking: block.text,
    ...(block.signature ? { thinkingSignature: block.signature } : {}),
    ...(block.redacted ? { redacted: true } : {}),
  }
  return {
    type: 'toolCall',
    id: block.id,
    name: block.name,
    arguments: block.arguments as ToolCall['arguments'],
    ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
    ...(block.namespace ? { namespace: block.namespace } : {}),
  }
}

function toModelPromptBlock(block: TextContent | ImageContent | ThinkingContent | ToolCall): ModelPromptBlock {
  if (block.type === 'image') return { type: 'image', data: block.data, mimeType: block.mimeType }
  return toModelBlock(block)
}

function toPiPromptBlock(block: ModelPromptBlock): TextContent | ImageContent | ThinkingContent | ToolCall {
  if (block.type === 'image') return { type: 'image', data: block.data, mimeType: block.mimeType }
  return toPiOutputBlock(block)
}

function toModelUsage(usage: Usage): ModelUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  }
}

function toPiUsage(usage: ModelUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  }
}

export function toModelCompletion(message: AssistantMessage): ModelCompletion {
  return {
    content: message.content.map(toModelBlock),
    apiId: message.api,
    providerId: String(message.provider),
    modelId: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.providerThinkingLevel ? { providerThinkingLevel: message.providerThinkingLevel } : {}),
    ...(message.diagnostics ? { diagnostics: structuredClone(message.diagnostics) as unknown[] } : {}),
    ...(message.deferred ? { deferred: structuredClone(message.deferred) } : {}),
    usage: toModelUsage(message.usage),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(message.rawStopReason ? { rawStopReason: message.rawStopReason } : {}),
    ...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
    timestamp: message.timestamp,
  }
}

export function toPiAssistantMessage(message: ModelCompletion): AssistantMessage {
  return {
    role: 'assistant',
    content: message.content.map(toPiOutputBlock),
    api: message.apiId as Api,
    provider: message.providerId as AssistantMessage['provider'],
    model: message.modelId,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.providerThinkingLevel ? { providerThinkingLevel: message.providerThinkingLevel } : {}),
    ...(message.diagnostics ? { diagnostics: message.diagnostics as AssistantMessage['diagnostics'] } : {}),
    ...(message.deferred ? { deferred: message.deferred as AssistantMessage['deferred'] } : {}),
    usage: toPiUsage(message.usage),
    stopReason: message.stopReason as AssistantMessage['stopReason'],
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(message.rawStopReason ? { rawStopReason: message.rawStopReason } : {}),
    ...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
    timestamp: message.timestamp,
  }
}

export function toModelInferenceContext(context: Context): ModelInferenceContext {
  const messages = context.messages.map((message): ModelPromptMessage => {
    if (message.role === 'system') return {
      role: 'system',
      content: typeof message.content === 'string' ? message.content : message.content.map((block) => ({
        type: 'text', text: block.text, ...(block.textSignature ? { signature: block.textSignature } : {}),
      })),
      ...(message.sections ? { sections: { ...message.sections } } : {}),
      ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.map(toModelTool) } : {}),
      ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved.map((tool) => ({ name: tool.name })) } : {}),
      timestamp: message.timestamp,
    }
    if (message.role === 'user') return {
      role: 'user',
      content: typeof message.content === 'string' ? message.content : message.content.map(toModelPromptBlock) as Array<ModelTextBlock | ModelImageBlock>,
      timestamp: message.timestamp,
    }
    if (message.role === 'assistant') return {
      ...toModelCompletion(message),
      role: 'assistant',
    }
    return {
      role: 'tool_result',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((block) => block.type === 'image'
        ? { type: 'image', data: block.data, mimeType: block.mimeType }
        : { type: 'text', text: block.text }),
      ...(message.details === undefined ? {} : { details: structuredClone(message.details) }),
      ...(message.usage ? { usage: toModelUsage(message.usage) } : {}),
      isError: message.isError,
      timestamp: message.timestamp,
    }
  })
  return {
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
    messages,
    ...(context.tools ? { tools: context.tools.map(toModelTool) } : {}),
  }
}

export function toPiContext(context: ModelInferenceContext): Context {
  const messages: Message[] = context.messages.map((message) => {
    if (message.role === 'system') return {
      role: 'system',
      content: typeof message.content === 'string' ? message.content : message.content.map((block) => ({
        type: 'text', text: block.text, ...(block.signature ? { textSignature: block.signature } : {}),
      })),
      ...(message.sections ? { sections: { ...message.sections } } : {}),
      ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.map(toPiTool) } : {}),
      ...(message.toolsRemoved ? { toolsRemoved: message.toolsRemoved.map((tool) => ({ name: tool.name })) } : {}),
      timestamp: message.timestamp,
    }
    if (message.role === 'user') return {
      role: 'user',
      content: typeof message.content === 'string' ? message.content : message.content.map(toPiPromptBlock) as Array<TextContent | ImageContent>,
      timestamp: message.timestamp,
    }
    if (message.role === 'assistant') return toPiAssistantMessage(message)
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((block) => block.type === 'image'
        ? { type: 'image', data: block.data, mimeType: block.mimeType }
        : { type: 'text', text: block.text }),
      ...(message.details === undefined ? {} : { details: message.details as ToolResultMessage['details'] }),
      ...(message.usage ? { usage: toPiUsage(message.usage) } : {}),
      isError: message.isError,
      timestamp: message.timestamp,
    }
  })
  return {
    ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
    messages,
    ...(context.tools ? { tools: context.tools.map(toPiTool) } : {}),
  }
}

export function toModelStreamEvent(event: AssistantMessageEvent): ModelStreamEvent {
  switch (event.type) {
    case 'start': return { type: event.type, partial: toModelCompletion(event.partial) }
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start': return { type: event.type, contentIndex: event.contentIndex, partial: toModelCompletion(event.partial) }
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta': return { type: event.type, contentIndex: event.contentIndex, delta: event.delta, partial: toModelCompletion(event.partial) }
    case 'text_end':
    case 'thinking_end': return { type: event.type, contentIndex: event.contentIndex, content: event.content, partial: toModelCompletion(event.partial) }
    case 'toolcall_end': return { type: event.type, contentIndex: event.contentIndex, toolCall: toModelBlock(event.toolCall) as ModelToolCallBlock, partial: toModelCompletion(event.partial) }
    case 'done': return { type: event.type, reason: event.reason, message: toModelCompletion(event.message) }
    case 'error': return { type: event.type, reason: event.reason, error: toModelCompletion(event.error) }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

export function toPiAssistantMessageEvent(event: ModelStreamEvent): AssistantMessageEvent {
  switch (event.type) {
    case 'start': return { type: event.type, partial: toPiAssistantMessage(event.partial) }
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start': return { type: event.type, contentIndex: event.contentIndex, partial: toPiAssistantMessage(event.partial) }
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta': return { type: event.type, contentIndex: event.contentIndex, delta: event.delta, partial: toPiAssistantMessage(event.partial) }
    case 'text_end':
    case 'thinking_end': return { type: event.type, contentIndex: event.contentIndex, content: event.content, partial: toPiAssistantMessage(event.partial) }
    case 'toolcall_end': return { type: event.type, contentIndex: event.contentIndex, toolCall: toPiOutputBlock(event.toolCall) as ToolCall, partial: toPiAssistantMessage(event.partial) }
    case 'done': return { type: event.type, reason: event.reason as Extract<AssistantMessageEvent, { type: 'done' }>['reason'], message: toPiAssistantMessage(event.message) }
    case 'error': return { type: event.type, reason: event.reason as Extract<AssistantMessageEvent, { type: 'error' }>['reason'], error: toPiAssistantMessage(event.error) }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

export function toModelRuntimeDescriptor(model: Model<Api>): ModelRuntimeDescriptor {
  return {
    id: model.id,
    name: model.name,
    provider: String(model.provider),
    api: model.api,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    cost: structuredClone(model.cost),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: structuredClone(model.thinkingLevelMap) as Record<string, string | null> } : {}),
    ...(model.samplingParams ? { samplingParams: structuredClone(model.samplingParams) } : {}),
    ...(model.promptCache ? { promptCache: structuredClone(model.promptCache) } : {}),
    ...(model.inputLimits ? { inputLimits: structuredClone(model.inputLimits) as Record<string, unknown> } : {}),
    ...(model.compat ? { compat: structuredClone(model.compat) as Record<string, unknown> } : {}),
  }
}

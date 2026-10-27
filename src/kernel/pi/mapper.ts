import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  Api,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import type {
  RuntimeContentBlock,
  RuntimeImageInput,
  RuntimeMessage,
} from '../../runtime/contracts.ts'
import { toRuntimeModelDescriptor } from '../../runtime/modelProjection.ts'

export function toPiImageContent(image: RuntimeImageInput): ImageContent {
  return { type: 'image', data: image.data, mimeType: image.mimeType }
}

/** Map pi-agent-core transcript messages to the pinned pi-ai request shape. */
export function createPiModelMessageMapper(getModel: () => Model<Api>) {
  return (messages: AgentMessage[]): Message[] => {
    const model = getModel()
    const compat = model.compat as any
    const requiresReasoningContent =
      compat?.requiresReasoningContentOnAssistantMessages && model.reasoning

    return messages.flatMap((message) => {
      switch (message.role) {
        case 'system':
          // pi-agent-core stores the active system prompt and tool loadout
          // changes in system messages. Dropping them makes models appear
          // tool-less even though the tools are registered in Agent.state.
          return [message as Message]

        case 'user':
        case 'toolResult':
          return [message as Message]

        case 'assistant': {
          if (model.api === 'openai-completions') {
            const thinkingText = message.content
              .filter((content: any) => content.type === 'thinking')
              .map((content: any) => content.thinking)
              .join('\n')
            const filtered = message.content.filter((content: any) => content.type !== 'thinking')
            const result: any = { ...message, content: filtered }
            if (requiresReasoningContent) result.reasoning_content = thinkingText || ''
            return [result as Message]
          }
          return [message as Message]
        }

        case 'bashExecution':
          return [{
            role: 'user' as const,
            content: `Command: ${message.command}\nOutput: ${message.output}`,
            timestamp: message.timestamp,
          }] as Message[]

        case 'compactionSummary':
          return [{
            role: 'user' as const,
            content: `[Previous conversation summary]\n${message.summary}`,
            timestamp: message.timestamp,
          }] as Message[]

        case 'branchSummary':
          return [{
            role: 'user' as const,
            content: `[Branch summary]\n${message.summary}`,
            timestamp: message.timestamp,
          }] as Message[]

        case 'custom':
          if (typeof message.content === 'string') {
            return [{
              role: 'user' as const,
              content: message.content,
              timestamp: message.timestamp,
            }] as Message[]
          }
          return []

        default:
          return []
      }
    })
  }
}

function jsonValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? undefined : JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

type PiContent = TextContent | ThinkingContent | ImageContent | ToolCall

function mapContent(content: PiContent): RuntimeContentBlock {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: content.text }
    case 'thinking':
      return {
        type: 'thinking',
        text: '',
        redacted: true,
      }
    case 'image':
      return { type: 'image', data: content.data, mime_type: content.mimeType }
    case 'toolCall':
      return {
        type: 'tool_call',
        call_id: content.id,
        tool_id: content.name,
        arguments: jsonValue(content.arguments) as Record<string, unknown> ?? {},
        ...(content.namespace ? { namespace: content.namespace } : {}),
      }
    default: {
      const unreachable: never = content
      return unreachable
    }
  }
}

function mapResultContent(content: ToolResultMessage['content']): Extract<RuntimeMessage, { role: 'tool_result' }>['content'] {
  return content.map((block) => {
    if (block.type === 'image') return { type: 'image', data: block.data, mime_type: block.mimeType }
    return { type: 'text', text: block.text }
  }) as Extract<RuntimeMessage, { role: 'tool_result' }>['content']
}

function mapSimpleContent(content: TextContent | ImageContent):
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string } {
  return content.type === 'image'
    ? { type: 'image', data: content.data, mime_type: content.mimeType }
    : { type: 'text', text: content.text }
}

export function toRuntimeMessage(message: AgentMessage): RuntimeMessage {
  switch (message.role) {
    case 'system':
      return {
        role: 'system',
        // The runtime DTO is a frontend projection; system instructions remain kernel-owned.
        content: '[system instructions]',
        timestamp: message.timestamp,
      }
    case 'user':
      return {
        role: 'user',
        content: typeof message.content === 'string'
          ? message.content
          : message.content.map(mapContent),
        timestamp: message.timestamp,
      }
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content.map(mapContent),
        model: {
          provider_id: String(message.provider),
          model_id: message.model,
          api_id: message.api,
        },
        usage: {
          input_tokens: message.usage.input,
          output_tokens: message.usage.output,
          total_tokens: message.usage.totalTokens,
          cost: message.usage.cost.total,
        },
        stop_reason: message.stopReason,
        ...(message.errorMessage ? { error_message: message.errorMessage } : {}),
        timestamp: message.timestamp,
      }
    case 'toolResult':
      return {
        role: 'tool_result',
        call_id: message.toolCallId,
        tool_id: message.toolName,
        content: mapResultContent(message.content),
        ...(message.details === undefined ? {} : { details: jsonValue(message.details) }),
        is_error: message.isError,
        timestamp: message.timestamp,
      }
    case 'bashExecution':
      return {
        role: 'command_activity',
        command: message.command,
        output: message.output,
        exit_code: message.exitCode ?? null,
        cancelled: message.cancelled,
        truncated: message.truncated,
        ...(message.fullOutputPath ? { full_output_path: message.fullOutputPath } : {}),
        timestamp: message.timestamp,
      }
    case 'custom':
      return {
        role: 'custom',
        kind: message.customType,
        content: typeof message.content === 'string' ? message.content : message.content.map(mapSimpleContent),
        display: message.display,
        ...(message.details === undefined ? {} : { details: jsonValue(message.details) }),
        timestamp: message.timestamp,
      }
    case 'branchSummary':
      return {
        role: 'summary',
        kind: 'branch',
        summary: message.summary,
        from_id: message.fromId,
        timestamp: message.timestamp,
      }
    case 'compactionSummary':
      return {
        role: 'summary',
        kind: 'compaction',
        summary: message.summary,
        tokens_before: message.tokensBefore,
        timestamp: message.timestamp,
      }
    default: {
      const unreachable: never = message
      return unreachable
    }
  }
}

export const toRuntimeModel = toRuntimeModelDescriptor

import { BACKGROUND_CONTEXT, generateSummary } from '@earendil-works/pi-agent-core'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  restoreLegacyCompactionContext,
  type CompactionSummaryGenerator,
} from '../../session/CompactionManager.ts'
import type { CompactionMessageAdapter } from '../../session/contracts.ts'
import { estimateMessagesTokens } from '../../session/TokenEstimator.ts'
import { getCompactUserSummaryMessage } from '../../session/compactPrompt.ts'

function getPiToolCalls(message: AgentMessage) {
  if (message.role !== 'assistant') return []
  return message.content
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    }))
}

function getPiToolResult(message: AgentMessage) {
  return message.role === 'toolResult'
    ? { callId: message.toolCallId, toolName: message.toolName }
    : undefined
}

export const piCompactionMessageAdapter: CompactionMessageAdapter<AgentMessage> = {
  getToolCalls: getPiToolCalls,
  getToolResult: getPiToolResult,
  getTimestamp(message) {
    return 'timestamp' in message && typeof message.timestamp === 'number'
      ? message.timestamp
      : undefined
  },
  estimateTokens(messages) {
    return estimateMessagesTokens(messages)
  },
  formatMalformedUnit(messages) {
    return messages.map((message) => {
      const result = getPiToolResult(message)
      if (result) {
        const content = message.role === 'toolResult'
          ? message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
          : ''
        return `Tool result ${result.toolName} (${result.callId}): ${content}`
      }
      const calls = getPiToolCalls(message)
      if (calls.length > 0) {
        return `Assistant requested tools: ${calls
          .map((call) => `${call.name}(${JSON.stringify(call.arguments)})`)
          .join(', ')}`
      }
      return `${message.role}: ${JSON.stringify(message)}`
    }).join('\n')
  },
  createUserMessage(content, timestamp) {
    return { role: 'user', content, timestamp }
  },
  createSummaryMessage(summary, timestamp) {
    return {
      role: 'user',
      content: getCompactUserSummaryMessage(summary),
      timestamp,
    }
  },
  replaceToolResultContent(message, content) {
    if (message.role !== 'toolResult') return message
    return {
      ...message,
      content: [{ type: 'text', text: content }],
    }
  },
}

/** Pi-backed session compatibility bridge for legacy compaction entries. */
export function restoreLegacyPiCompactionContext(
  messages: readonly AgentMessage[],
  contextWindow: number,
  tokensBefore: number,
  summary: string,
  timestamp: number,
): AgentMessage[] {
  return restoreLegacyCompactionContext(
    messages,
    contextWindow,
    tokensBefore,
    summary,
    timestamp,
    piCompactionMessageAdapter,
  )
}

/** Keeps Pi's summary API behind the kernel adapter and exposes the runtime summarizer contract. */
export function createPiCompactionSummarizer(options: {
  models: Models
  getModel: () => Model<Api>
}): CompactionSummaryGenerator<AgentMessage> {
  return async (messages, summaryOptions) => {
    const result = await generateSummary(
      [...messages] as AgentMessage[],
      options.models,
      options.getModel(),
      summaryOptions.reserveTokens,
      summaryOptions.instructions,
      undefined,
      undefined,
      undefined,
      undefined,
      BACKGROUND_CONTEXT,
    )
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, error: { message: result.error.message } }
  }
}

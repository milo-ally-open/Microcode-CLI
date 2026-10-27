const IMAGE_TOKEN_ESTIMATE = 2000

/** Minimal message shape needed for token estimation; independent of any kernel. */
export interface TokenEstimatorBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  arguments?: unknown
}

export interface TokenEstimatorMessage {
  role: string
  content?: string | readonly TokenEstimatorBlock[]
  command?: string
  output?: string
  summary?: string
}

function contentBlocks(content: string | readonly TokenEstimatorBlock[] | undefined): readonly TokenEstimatorBlock[] {
  return Array.isArray(content) ? content as readonly TokenEstimatorBlock[] : []
}

/**
 * Estimate token count for messages using a character-based heuristic: roughly
 * one token per four text characters, with a fixed estimate for image blocks.
 */
export function estimateTokens(message: TokenEstimatorMessage): number {
  let chars = 0

  switch (message.role) {
    case 'user': {
      const content = message.content
      if (typeof content === 'string') {
        chars = content.length
      } else {
        for (const block of contentBlocks(content)) {
          if (block.type === 'text' && block.text) {
            chars += block.text.length
          }
          if (block.type === 'image') {
            chars += IMAGE_TOKEN_ESTIMATE * 4
          }
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'assistant': {
      for (const block of contentBlocks(message.content)) {
        if (block.type === 'text') {
          chars += block.text?.length ?? 0
        } else if (block.type === 'thinking') {
          chars += block.thinking?.length ?? 0
        } else if (block.type === 'toolCall') {
          chars += (block.name?.length ?? 0) + (JSON.stringify(block.arguments ?? {})?.length ?? 0)
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'toolResult': {
      for (const block of contentBlocks(message.content)) {
        if (block.type === 'text' && block.text) {
          chars += block.text.length
        }
        if (block.type === 'image') {
          chars += IMAGE_TOKEN_ESTIMATE * 4
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'bashExecution': {
      chars = (message.command?.length ?? 0) + (message.output?.length ?? 0)
      return Math.ceil(chars / 4)
    }
    case 'compactionSummary':
    case 'branchSummary': {
      chars = message.summary?.length ?? 0
      return Math.ceil(chars / 4)
    }
    case 'custom': {
      if (typeof message.content === 'string') {
        chars = message.content.length
      } else {
        for (const block of contentBlocks(message.content)) {
          if (block.type === 'text' && block.text) {
            chars += block.text.length
          }
        }
      }
      return Math.ceil(chars / 4)
    }
  }
  return 0
}

/**
 * Estimate total tokens for a message array.
 */
export function estimateMessagesTokens(messages: readonly TokenEstimatorMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateTokens(message)
  }
  return total
}

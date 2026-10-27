import { registerTool } from '../registry.ts'
import { createBashTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './BashTool.ts'
import { joinSummaryParts, producedText, statusPrefix } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createBashTool,
    formatDescription: (input) => typeof input.command === 'string' ? input.command : '(unknown command)',
    extractMatchContent: (input) => typeof input.command === 'string' ? input.command : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const exitCode = details.exitCode === null || typeof details.exitCode === 'number'
        ? `exit=${details.exitCode}`
        : undefined
      return `[bash] ${statusPrefix(context)}${joinSummaryParts([exitCode, producedText(context)])}`
    },
  },
})

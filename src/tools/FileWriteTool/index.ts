import { registerTool } from '../registry.ts'
import { createFileWriteTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './FileWriteTool.ts'
import { count, joinSummaryParts, statusPrefix, text } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createFileWriteTool,
    formatDescription: (input) => typeof input.file_path === 'string' ? `write ${input.file_path}` : '(unknown file)',
    extractMatchContent: (input) => typeof input.file_path === 'string' ? input.file_path : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const state = details.written === false ? 'not written' : 'written'
      const warning = typeof details.warning === 'string' ? `warning: ${details.warning}` : undefined
      return `[write] ${statusPrefix(context)}${joinSummaryParts([
        text(details.path), state, count(details.bytesWritten, 'bytes'),
        count(details.additions, 'additions'), count(details.removals, 'removals'), warning,
      ])}`
    },
  },
})

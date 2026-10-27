import { registerTool } from '../registry.ts'
import { createFileReadTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './FileReadTool.ts'
import { boolTag, count, joinSummaryParts, statusPrefix, text } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createFileReadTool,
    formatDescription: (input) => typeof input.file_path === 'string' ? `read ${input.file_path}` : '(unknown file)',
    extractMatchContent: (input) => typeof input.file_path === 'string' ? input.file_path : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      return `[read] ${statusPrefix(context)}${joinSummaryParts([
        text(details.path), count(details.returnedLines, 'returned lines'),
        count(details.totalLines, 'total lines'), boolTag(details.truncated, 'truncated') ?? 'complete',
      ])}`
    },
  },
})

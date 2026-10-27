import { registerTool } from '../registry.ts'
import { createFileEditTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './FileEditTool.ts'
import { count, joinSummaryParts, statusPrefix, text } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createFileEditTool,
    formatDescription: (input) => typeof input.file_path === 'string' ? `edit ${input.file_path}` : '(unknown file)',
    extractMatchContent: (input) => typeof input.file_path === 'string' ? input.file_path : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      return `[edit] ${statusPrefix(context)}${joinSummaryParts([
        text(details.path), count(details.replacements, 'replacements'),
        count(details.additions, 'additions'), count(details.removals, 'removals'),
      ])}`
    },
  },
})

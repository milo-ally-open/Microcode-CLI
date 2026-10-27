import { registerTool } from '../registry.ts'
import { createGlobTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './GlobTool.ts'
import { boolTag, count, joinSummaryParts, previewList, statusPrefix } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createGlobTool,
    description:
      'Find files by glob pattern using ripgrep. Returns matching file paths sorted by modification time. Supports standard glob patterns like "**/*.ts" or "src/**/*.spec.ts".',
    formatDescription: (input) => typeof input.pattern === 'string' ? `glob ${input.pattern}` : '(unknown pattern)',
    extractMatchContent: (input) => typeof input.pattern === 'string' ? input.pattern : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const duration = typeof details.durationMs === 'number' ? `${details.durationMs}ms` : undefined
      return `[glob] ${statusPrefix(context)}${joinSummaryParts([
        count(details.numFiles, 'files'), boolTag(details.truncated, 'truncated'), duration,
        previewList(details.filenames, 8, 'files'),
      ])}`
    },
  },
})

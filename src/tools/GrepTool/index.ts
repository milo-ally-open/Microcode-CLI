import { registerTool } from '../registry.ts'
import { createGrepTool, TOOL_NAME, TOOL_DEFAULT_PERMISSION } from './GrepTool.ts'
import { boolTag, count, joinSummaryParts, previewList, statusPrefix } from '../summary.ts'

registerTool({
  name: TOOL_NAME,
  policy: { defaultPermission: TOOL_DEFAULT_PERMISSION },
  agent: {
    create: createGrepTool,
    description:
      'Search file contents with regex using ripgrep. Supports full regex syntax, output modes (content/files_with_matches/count), file type filtering, context lines, and pagination (head_limit/offset). Use in preference to running grep/rg from Bash.',
    formatDescription: (input) => {
      if (typeof input.pattern === 'string') {
        const mode = input.output_mode ? ` [${input.output_mode}]` : ''
        return `grep /${input.pattern}/${mode}`
      }
      return '(unknown pattern)'
    },
    extractMatchContent: (input) => typeof input.pattern === 'string' ? input.pattern : undefined,
    summarizeResult: (context) => {
      const details = context.details ?? {}
      const mode = typeof details.mode === 'string' ? `mode=${details.mode}` : undefined
      return `[grep] ${statusPrefix(context)}${joinSummaryParts([
        mode, count(details.numFiles, 'files'), count(details.numMatches, 'matches'),
        count(details.numLines, 'lines'), boolTag(details.truncated, 'truncated'),
        previewList(details.filenames, 5, 'files'),
      ])}`
    },
  },
})

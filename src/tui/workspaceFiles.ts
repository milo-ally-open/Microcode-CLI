export {
  buildWorkspaceFileContext,
  formatFileMention,
  getMentionedImagePaths,
  listWorkspaceFiles,
  parseFileMentions,
  readMentionedFile,
} from '../utils/workspaceFileReferences.ts'
import { formatFileMention } from '../utils/workspaceFileReferences.ts'

export { filterWorkspaceFiles } from '../utils/workspaceFileReferences.ts'

export function highlightWorkspaceFileMentions(text: string, highlight: (mention: string) => string): string {
  const pattern = /(?<![\w@])@(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s]+)/g
  return text.replace(pattern, (mention) => highlight(mention))
}

export function applyWorkspaceFileCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  prefix: string,
  path: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const updated = [...lines]
  const currentLine = updated[cursorLine] ?? ''
  const beforePrefix = currentLine.slice(0, cursorCol - prefix.length)
  const afterCursor = currentLine.slice(cursorCol)
  const value = formatFileMention(path)
  updated[cursorLine] = `${beforePrefix}${value} ${afterCursor}`
  return { lines: updated, cursorLine, cursorCol: beforePrefix.length + value.length + 1 }
}

/** Count logical content lines without inventing a row for a final newline. */
export function countContentLines(content: string): number {
  if (content.length === 0) return 0

  let lineCount = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) lineCount++
  }

  return content.endsWith('\n') ? lineCount - 1 : lineCount
}

export const countLines = countContentLines

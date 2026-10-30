import type { ToolResult } from './toolPresentationRegistry.ts'
import { truncateToWidth } from '@earendil-works/pi-tui'
import { normalizeTerminalText } from '../utils/terminalText.ts'

export interface BoundedPreview {
  rows: string[]
  totalRows: number
  truncated: boolean
}

/** Project text blocks into bounded display rows without changing the tool result. */
export function boundedTextPreview(
  text: string,
  maxRows = 200,
  maxChars = 40_000,
): BoundedPreview {
  const normalizedText = normalizeTerminalText(text)
  const characters = Array.from(normalizedText)
  const limitedText = characters.slice(0, maxChars).join('')
  const allRows = limitedText.split(/\r?\n/)
  const truncated = characters.length > maxChars || allRows.length > maxRows
  const rows = allRows.slice(0, truncated ? Math.max(0, maxRows - 1) : maxRows)
  if (truncated) {
    const omittedRows = Math.max(0, allRows.length - rows.length)
    rows.push(`… ${omittedRows || 'additional'} more lines${characters.length > maxChars ? ' (preview limit reached)' : ''}`)
  }
  return { rows, totalRows: allRows.length, truncated }
}

export function textFromToolResult(result: ToolResult | undefined): string {
  return normalizeTerminalText(result?.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n') ?? '')
}

export function oneLine(value: string, limit = 120): string {
  const normalized = normalizeTerminalText(value).replace(/\s+/g, ' ').trim()
  return truncateToWidth(normalized, limit, '…')
}

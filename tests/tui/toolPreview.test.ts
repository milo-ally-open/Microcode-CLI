import { describe, expect, test } from 'bun:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import { boundedTextPreview, oneLine, textFromToolResult } from '../../src/tui/toolPreview.ts'

describe('tool preview text', () => {
  test('strips terminal controls and normalizes carriage-return progress output', () => {
    const raw = '\u001b[31m构建完成\u001b[0m\r\nprogress 10%\rprogress 100%\nold\b!'

    expect(boundedTextPreview(raw).rows).toEqual(['构建完成', 'progress 100%', 'ol!'])
    expect(textFromToolResult({ content: [{ type: 'text', text: raw }], isError: false }))
      .toBe('构建完成\nprogress 100%\nol!')
  })

  test('one-line summaries truncate by terminal columns without splitting Unicode', () => {
    const summary = oneLine('界'.repeat(10), 5)
    const plain = summary.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')

    expect(plain.endsWith('…')).toBe(true)
    expect(visibleWidth(summary)).toBeLessThanOrEqual(5)
    expect(Array.from(plain).every((character) => character === '界' || character === '…')).toBe(true)
  })
})

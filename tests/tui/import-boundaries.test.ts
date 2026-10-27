import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

describe('TUI runtime import boundaries', () => {
  test('permission views and facades import neutral permission contracts', async () => {
    const files = [
      new URL('../../src/tui/app.ts', import.meta.url),
      new URL('../../src/tui/agentPort.ts', import.meta.url),
      new URL('../../src/tui/runtimeAgentFacade.ts', import.meta.url),
    ]
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))

    expect(sources[0]).toContain("from '../permissions/types.ts'")
    expect(sources.join('\n')).not.toContain("from '../permissions/index.ts'")
  })
})

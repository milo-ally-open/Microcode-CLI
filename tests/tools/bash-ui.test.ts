import { describe, expect, test } from 'bun:test'
import { BashToolUI } from '../../src/tui/toolViews/Bash.tsx'

describe('BashToolUI', () => {
  test('hides output by default and shows expanded rows on request', () => {
    const output = Array.from({ length: 60 }, (_, index) => `ROW_${String(index).padStart(3, '0')}`).join('\n')
    const component = new BashToolUI('tool-call', { command: 'cat long-file.txt' })
    component.updateDetails({ stdout: output, stderr: '', output, exitCode: 0 })
    component.updateResult({ content: [{ type: 'text', text: output }], isError: false })

    const collapsed = component.render(120).join('\n')
    expect(collapsed).not.toContain('ROW_000')
    expect(collapsed).not.toContain('ROW_059')
    expect(collapsed).not.toContain('ROW_030')
    expect(collapsed).toContain('[Expand preview]')
    expect(collapsed).not.toContain('exit: 0')
    expect(collapsed.split('\n').some((line) => line.includes('[Expand preview]'))).toBe(true)
    expect(component.hasToggleButton()).toBe(true)

    component.setExpanded(true)
    const expanded = component.render(120).join('\n')
    expect(expanded).toContain('ROW_030')
    expect(expanded).toContain('ROW_029')
    expect(expanded).not.toContain('│ ROW_029')
  })

  test('keeps a very long output line hidden until expanded', () => {
    const output = 'x'.repeat(5_000)
    const component = new BashToolUI('tool-call', { command: 'cat single-line.txt' })
    component.updateDetails({ stdout: output, stderr: '', output, exitCode: 0 })
    component.updateResult({ content: [{ type: 'text', text: output }], isError: false })

    const collapsed = component.render(120).join('\n')
    expect(collapsed).toContain('[Expand preview]')
    expect(collapsed).not.toContain(output)
    expect(component.hasToggleButton()).toBe(true)

    component.setExpanded(true)
    const expanded = component.render(120).join('\n')
    expect((expanded.match(/x/g) ?? []).length).toBeGreaterThanOrEqual(5_000)
    expect(expanded).not.toContain('│ ')
  })

  test('restores malformed historical output fields without throwing', () => {
    const component = new BashToolUI('tool-call', { command: 'echo test' })
    component.updateDetails({ stdout: 12, stderr: null, output: { old: 'shape' }, exitCode: 0 })

    expect(() => component.render(80)).not.toThrow()
  })

  test('cleans terminal controls and keeps Unicode intact in expanded output', () => {
    const component = new BashToolUI('tool-call', { command: 'echo status' })
    const output = '\u001b[31m构建完成\u001b[0m\r\nprogress 10%\rprogress 100%\nold\b!'
    component.updateDetails({ stdout: output, stderr: '', output, exitCode: 0 })
    component.updateResult({ content: [{ type: 'text', text: output }], isError: false })
    component.setExpanded(true)

    const rendered = component.render(80).join('\n')
    expect(rendered).toContain('构建完成')
    expect(rendered).toContain('progress 100%')
    expect(rendered).toContain('ol!')
    expect(rendered).not.toContain('\u001b')
    expect(rendered).not.toContain('\b')
  })

  test('keeps failing exit codes visible while successful exit codes stay implicit', () => {
    const component = new BashToolUI('tool-call', { command: 'false' })
    component.updateDetails({ stdout: '', stderr: 'failed', output: 'failed', exitCode: 2 })
    component.updateResult({ content: [{ type: 'text', text: 'failed' }], isError: true })

    expect(component.render(80).join('\n')).toContain('exit: 2')
  })
})

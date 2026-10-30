import { stripVTControlCharacters } from 'node:util'

/** Remove terminal control sequences and normalize command/file text for plain TUI previews. */
export function normalizeTerminalText(value: string): string {
  const withoutControls = stripVTControlCharacters(value)
    .replace(/\r\n/g, '\n')
    .replace(/\0/g, '')

  return withoutControls
    .split('\n')
    .map((line) => {
      // A bare carriage return means "overwrite this terminal line".
      let current = line.split('\r').at(-1) ?? ''
      while (current.includes('\b')) {
        current = current.replace(/[^\x08]\x08/g, '').replace(/\x08/g, '')
      }
      return current.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trimEnd()
    })
    .join('\n')
}

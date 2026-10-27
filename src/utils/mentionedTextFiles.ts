import { constants } from 'node:fs'
import { access, open, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const MENTION_FILE_MAX_BYTES = 64 * 1024

const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'conf', 'cpp', 'cs', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java',
  'js', 'jsx', 'json', 'kt', 'log', 'md', 'mdx', 'mjs', 'mts', 'php', 'py', 'rb', 'rs', 'sh',
  'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_BASENAMES = new Set([
  '.dockerignore', '.editorconfig', '.env', '.gitignore', 'dockerfile', 'makefile', 'readme',
])

function hasTextExtension(filePath: string): boolean {
  const baseName = filePath.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const extension = baseName.includes('.') ? baseName.split('.').at(-1) ?? '' : ''
  return TEXT_BASENAMES.has(baseName) || TEXT_EXTENSIONS.has(extension)
}

export function supportsMentionedTextFile(filePath: string): boolean {
  return hasTextExtension(filePath)
}

export function decodeTextBytes(bytes: Uint8Array, streaming = false): string | undefined {
  if (bytes.includes(0)) return undefined
  const sample = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  const prefix = sample.slice(0, 16)
  if (
    /^\s*%PDF-/.test(sample) || prefix.startsWith('PK\x03\x04') || prefix.startsWith('PK\x05\x06') ||
    prefix.startsWith('PK\x07\x08') || prefix.startsWith('\x7fELF') || prefix.startsWith('SQLite format 3') ||
    prefix.startsWith('\x1f\x8b') || prefix.startsWith('\xd0\xcf\x11\xe0') || prefix.startsWith('7z\xbc\xaf\x27\x1c') ||
    prefix.startsWith('Rar!') || prefix.startsWith('\x89PNG\r\n\x1a\n') || prefix.startsWith('\xff\xd8\xff') ||
    prefix.startsWith('GIF8') || prefix.startsWith('RIFF') || prefix.startsWith('BM')
  ) return undefined
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return undefined
    if (byte === 0x7f) return undefined
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: streaming })
  } catch {
    return undefined
  }
}

/** Safely read a bounded prefix for explicit @file context; unsupported/invalid formats return undefined. */
export async function readMentionedTextFile(
  cwd: string,
  relativePath: string,
  maxBytes = MENTION_FILE_MAX_BYTES,
): Promise<{ content: string; truncated: boolean } | undefined> {
  if (!hasTextExtension(relativePath)) return undefined
  const root = resolve(cwd)
  const filePath = resolve(root, relativePath)
  const relativePathCheck = relative(root, filePath)
  if (
    !relativePathCheck || relativePathCheck === '..' || relativePathCheck.startsWith(`..${sep}`) ||
    isAbsolute(relativePathCheck)
  ) return undefined
  await access(filePath, constants.R_OK)
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) return undefined
  const handle = await open(filePath, 'r')
  try {
    const bytes = Buffer.alloc(Math.max(1, maxBytes) + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const truncated = bytesRead > maxBytes || fileStat.size > maxBytes
    const visibleBytes = bytes.subarray(0, Math.min(bytesRead, maxBytes))
    if (decodeTextBytes(visibleBytes, truncated) === undefined) return undefined
    const content = new TextDecoder('utf-8', { fatal: true }).decode(visibleBytes, { stream: truncated })
    return { content, truncated }
  } finally {
    await handle.close()
  }
}

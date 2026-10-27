import type { TuiPlugin } from './pluginPort.ts'

export function filterMentionablePlugins(plugins: readonly TuiPlugin[], query: string): TuiPlugin[] {
  const needle = query.toLowerCase()
  return plugins
    .filter((plugin) => plugin.enabled && plugin.valid && plugin.health !== 'incompatible' && plugin.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      const score = (name: string) => name.toLowerCase() === needle ? 0 : name.toLowerCase().startsWith(needle) ? 1 : 2
      return score(a.name) - score(b.name) || a.name.localeCompare(b.name)
    })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionPattern(pluginNames: readonly string[]): RegExp | undefined {
  if (pluginNames.length === 0) return undefined
  const names = [...new Set(pluginNames)].sort((a, b) => b.length - a.length).map(escapeRegExp)
  return new RegExp(`(?<![\\w#])#(${names.join('|')})(?![\\w-])`, 'gi')
}

export function parsePluginMentions(text: string, plugins: readonly TuiPlugin[]): string[] {
  const byLowerName = new Map(plugins.filter((plugin) => plugin.enabled && plugin.valid && plugin.health !== 'incompatible').map((plugin) => [plugin.name.toLowerCase(), plugin.name]))
  const pattern = mentionPattern([...byLowerName.keys()])
  if (!pattern) return []
  const names: string[] = []
  for (const match of text.matchAll(pattern)) {
    const name = match[1] ? byLowerName.get(match[1].toLowerCase()) : undefined
    if (name) names.push(name)
  }
  return [...new Set(names)]
}

export function highlightPluginMentions(
  text: string,
  pluginNames: readonly string[],
  highlight: (mention: string) => string,
): string {
  const pattern = mentionPattern(pluginNames)
  return pattern ? text.replace(pattern, (mention) => highlight(mention)) : text
}

export function highlightPluginMatch(
  text: string,
  query: string,
  highlight: (match: string) => string,
): string {
  if (!query) return text
  const start = text.toLowerCase().indexOf(query.toLowerCase())
  if (start === -1) return text
  const end = start + query.length
  return `${text.slice(0, start)}${highlight(text.slice(start, end))}${text.slice(end)}`
}

export function isPluginAutocompleteContext(textBeforeCursor: string): boolean {
  return /(?:^|[\s([{])#[a-z0-9-]*$/i.test(textBeforeCursor)
}

export function applyPluginCompletion(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  prefix: string,
  name: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const updated = [...lines]
  const currentLine = updated[cursorLine] ?? ''
  const beforePrefix = currentLine.slice(0, cursorCol - prefix.length)
  const afterCursor = currentLine.slice(cursorCol)
  const value = `#${name}`
  updated[cursorLine] = `${beforePrefix}${value} ${afterCursor}`
  return { lines: updated, cursorLine, cursorCol: beforePrefix.length + value.length + 1 }
}

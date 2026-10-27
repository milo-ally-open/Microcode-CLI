import { Container, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import chalk from 'chalk'
import type { ToolInteractionTarget, ToolUIComponent } from '../toolPresentationRegistry.ts'

type EntryKind = 'user' | 'assistant' | 'tool' | 'status'

interface TimelineEntry {
  component: Component
  kind: EntryKind
}

type TranscriptCacheAwareComponent = Component & {
  isTranscriptRenderStable?: () => boolean
  setRenderInvalidationListener?: (listener?: () => void) => void
}

function setRenderInvalidationListener(component: Component, listener?: () => void): void {
  (component as TranscriptCacheAwareComponent).setRenderInvalidationListener?.(listener)
}

/** Renders one user turn as a connected vertical activity rail. */
export class TurnTimeline extends Container {
  private entries: TimelineEntry[] = []
  private activity?: Text
  private renderedWidth?: number
  private renderedToolTargets: ToolInteractionTarget[] = []
  private unstableEntries = new Set<Component>()
  private onInvalidate?: () => void

  setRenderInvalidationListener(listener?: () => void): void {
    this.onInvalidate = listener
  }

  private notifyInvalidated(): void {
    this.renderedWidth = undefined
    this.renderedToolTargets = []
    this.onInvalidate?.()
  }

  private observeEntry(component: Component): void {
    const cacheAware = component as TranscriptCacheAwareComponent
    const updateStability = () => {
      if (cacheAware.isTranscriptRenderStable?.() === false) this.unstableEntries.add(component)
      else this.unstableEntries.delete(component)
      this.notifyInvalidated()
    }
    if (cacheAware.isTranscriptRenderStable?.() === false) this.unstableEntries.add(component)
    if (cacheAware.setRenderInvalidationListener) {
      cacheAware.setRenderInvalidationListener(updateStability)
    }
  }

  addEntry(component: Component, kind: EntryKind = 'status'): void {
    // Streaming tool updates can revisit the same component. A timeline owns a
    // component once; inserting it twice renders duplicate transcript rows.
    if (this.entries.some((entry) => entry.component === component)) return
    if (this.activity) this.entries.pop()
    this.entries.push({ component, kind })
    this.observeEntry(component)
    if (this.activity) this.entries.push({ component: this.activity, kind: 'status' })
    this.notifyInvalidated()
  }

  setActivity(label?: string): void {
    if (!label) {
      if (!this.activity) return
      this.entries = this.entries.filter((entry) => entry.component !== this.activity)
      this.activity = undefined
      this.notifyInvalidated()
      return
    }

    if (!this.activity) {
      this.activity = new Text(label, 0, 0)
      this.entries.push({ component: this.activity, kind: 'status' })
      this.notifyInvalidated()
      return
    }

    this.activity.setText(label)
    this.notifyInvalidated()
  }

  getToolInteractionTargets(width: number): ToolInteractionTarget[] {
    return width === this.renderedWidth ? this.renderedToolTargets : []
  }

  isTranscriptRenderStable(): boolean {
    return this.unstableEntries.size === 0
  }

  render(width: number): string[] {
    this.renderedWidth = width
    this.renderedToolTargets = []
    if (this.entries.length === 0) return []

    const connected = this.entries.some((entry) => entry.kind === 'tool')
    if (!connected) {
      return this.entries.flatMap(({ component }) => component.render(width))
    }

    const lines: string[] = []
    const railWidth = 3
    const entryWidth = Math.max(1, width - railWidth)

    for (let entryIndex = 0; entryIndex < this.entries.length; entryIndex++) {
      const entry = this.entries[entryIndex]!
      const renderedWidth = entryIndex === 0 ? width : entryWidth
      const entryLines = entry.component.render(renderedWidth)
      if (entry.kind === 'tool') {
        const tool = entry.component as ToolUIComponent
        for (const target of tool.getInteractionTargets?.(entryLines) ?? []) {
          this.renderedToolTargets.push({
            ...target,
            rowOffset: lines.length + target.rowOffset,
            startColumn: target.startColumn + (entryIndex > 0 ? railWidth : 0),
            endColumn: target.endColumn + (entryIndex > 0 ? railWidth : 0),
          })
        }
      }
      if (entryIndex === 0) {
        lines.push(...entryLines)
        continue
      }

      const isLast = entryIndex === this.entries.length - 1
      const branch = isLast ? '└─ ' : '├─ '
      for (let lineIndex = 0; lineIndex < entryLines.length; lineIndex++) {
        const prefix = lineIndex === 0 ? branch : '│  '
        lines.push(chalk.white(prefix) + entryLines[lineIndex]!)
      }
    }

    return lines
  }

  invalidate(): void {
    for (const { component } of this.entries) component.invalidate?.()
    this.notifyInvalidated()
  }
}

/** Renders chat children once and records preview hit targets in transcript coordinates. */
export class ChatTranscript extends Container {
  private renderedWidth?: number
  private renderedToolTargets: ToolInteractionTarget[] = []
  private renderedLines?: string[]
  private nonCacheableChildren = new Set<Component>()

  private isCacheableComponent(component: Component): boolean {
    if (component instanceof Text || component instanceof Spacer) return true
    const cacheAware = component as TranscriptCacheAwareComponent
    return cacheAware.isTranscriptRenderStable?.() === true
  }

  private updateChildStability(component: Component): void {
    if (this.isCacheableComponent(component)) this.nonCacheableChildren.delete(component)
    else this.nonCacheableChildren.add(component)
  }

  addChild(component: Component): void {
    super.addChild(component)
    setRenderInvalidationListener(component, () => {
      this.updateChildStability(component)
      this.invalidateRenderedContent()
    })
    this.updateChildStability(component)
    this.invalidateRenderedContent()
  }

  removeChild(component: Component): void {
    const wasPresent = this.children.includes(component)
    if (wasPresent) {
      setRenderInvalidationListener(component, undefined)
      this.nonCacheableChildren.delete(component)
    }
    super.removeChild(component)
    if (wasPresent) this.invalidateRenderedContent()
  }

  clear(): void {
    for (const component of this.children) {
      setRenderInvalidationListener(component, undefined)
    }
    super.clear()
    this.nonCacheableChildren.clear()
    this.invalidateRenderedContent()
  }

  /** Clear only the flattened transcript cache after a nested component changes. */
  invalidateRenderedContent(): void {
    this.renderedWidth = undefined
    this.renderedToolTargets = []
    this.renderedLines = undefined
  }

  invalidate(): void {
    super.invalidate()
    this.invalidateRenderedContent()
  }

  getToolInteractionTargets(width: number): ToolInteractionTarget[] {
    return width === this.renderedWidth ? this.renderedToolTargets : []
  }

  render(width: number): string[] {
    const cacheable = this.nonCacheableChildren.size === 0
    if (cacheable && this.renderedLines && this.renderedWidth === width) return this.renderedLines

    this.renderedWidth = width
    this.renderedToolTargets = []
    const lines: string[] = []

    for (const component of this.children) {
      const componentLines = component.render(width)
      const targets = component instanceof TurnTimeline
        ? component.getToolInteractionTargets(width)
        : (component as ToolUIComponent).getInteractionTargets?.(componentLines) ?? []

      this.renderedToolTargets.push(...targets.map((target) => ({
        ...target,
        rowOffset: lines.length + target.rowOffset,
      })))
      lines.push(...componentLines)
    }

    this.renderedLines = cacheable ? lines : undefined
    return lines
  }
}

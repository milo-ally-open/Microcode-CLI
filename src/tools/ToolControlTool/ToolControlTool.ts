import type { ToolAdapter, ToolExecutionResult } from '../contracts.ts'
import { Type } from 'typebox'

export const TOOL_CONTROL_TOOL_NAME = 'tool_control'

const toolControlSchema = Type.Object({
  operation: Type.Union([
    Type.Literal('list'),
    Type.Literal('enable'),
    Type.Literal('disable'),
  ]),
  tool_id: Type.Optional(Type.String({ description: 'Stable registry ID returned by the list operation' })),
})

export interface ToolControlSnapshot {
  version: number
  active: readonly string[]
  registered: readonly string[]
  mutable: readonly string[]
  disabled: readonly string[]
  unloaded: readonly string[]
}

export interface ToolControlOptions {
  getSnapshot: () => Readonly<ToolControlSnapshot>
  requestChange: (toolId: string, enabled: boolean) => void
}

export function createToolControlTool(options: ToolControlOptions): ToolAdapter<typeof toolControlSchema> {
  return {
    name: TOOL_CONTROL_TOOL_NAME,
    label: 'Tool Control',
    description: 'List registered tools, or enable/disable a mutable tool for this Agent session. Changes apply after this tool call. This never changes tool permissions.',
    parameters: toolControlSchema,
    async execute(_toolCallId, params): Promise<ToolExecutionResult<ToolControlSnapshot>> {
      const input = params as { operation: 'list' | 'enable' | 'disable'; tool_id?: string }
      if (input.operation === 'list') {
        if (input.tool_id !== undefined) throw new Error('tool_id is only accepted with enable or disable')
        const snapshot = options.getSnapshot()
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }],
          details: snapshot,
        }
      }

      if (!input.tool_id?.trim()) {
        throw new Error(`tool_id is required for ${input.operation}`)
      }
      options.requestChange(input.tool_id, input.operation === 'enable')
      return {
        content: [{ type: 'text', text: `Queued ${input.operation} for tool "${input.tool_id}". The change applies after this tool call.` }],
        details: options.getSnapshot(),
      }
    },
  }
}

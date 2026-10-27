import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ToolAdapter } from '../../tools/contracts.ts'

/** Bind a Microcode tool contract to the pinned Pi AgentTool contract. */
export function toPiAgentTool(tool: ToolAdapter<any, any>): AgentTool<any, any> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments } : {}),
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<any>> {
      return tool.execute(toolCallId, params, signal, onUpdate)
    },
  }
}

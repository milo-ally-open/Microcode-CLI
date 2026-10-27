import { registerTool } from '../registry.ts'
import { TOOL_CONTROL_TOOL_NAME } from './ToolControlTool.ts'

registerTool({
  name: TOOL_CONTROL_TOOL_NAME,
  version: 1,
  mutable: false,
  policy: { defaultPermission: 'allow' },
  agent: {
    create: () => {
      throw new Error('ToolControlTool must be created by the AgentToolManager')
    },
    description: 'List registered tools, or enable/disable a mutable tool for this Agent session. Tool changes never grant execution permission.',
  },
})

export { createToolControlTool, TOOL_CONTROL_TOOL_NAME } from './ToolControlTool.ts'

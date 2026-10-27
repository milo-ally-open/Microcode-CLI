import { Agent, type AgentEvent, type AgentMessage, type AgentOptions, type ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import type {
  KernelAgentPort,
  KernelAgentEvent,
  KernelAgentSnapshot,
  KernelAfterToolCall,
  KernelBeforeToolCall,
} from '../contracts.ts'
import type { RuntimeImageInput } from '../../runtime/contracts.ts'
import type { ToolAdapter } from '../../tools/contracts.ts'
import { toPiImageContent } from './mapper.ts'
import { toPiAgentTool } from './toolAdapter.ts'

/** Pi-specific implementation of the runtime kernel contract. */
export type PiKernelAgent = KernelAgentPort<
  AgentMessage,
  Model<Api>,
  ToolAdapter<any, any>,
  KernelAgentEvent<AgentMessage>,
  ThinkingLevel,
  RuntimeImageInput
>

type PiKernelAgentOptions = Omit<AgentOptions, 'beforeToolCall' | 'afterToolCall' | 'initialState'> & {
  initialState?: Omit<NonNullable<AgentOptions['initialState']>, 'tools'> & {
    tools?: readonly ToolAdapter<any, any>[]
  }
}

function mapAssistantMessageEvent(event: Extract<AgentEvent, { type: 'message_update' }>['assistantMessageEvent']) {
  const mapped: {
    type: string
    contentIndex?: number
    delta?: string
    content?: unknown
    partial?: AgentMessage
    message?: AgentMessage
    error?: AgentMessage
    toolCall?: { id: string; name: string; arguments: Record<string, unknown>; namespace?: string }
    reason?: string
  } = { type: event.type }
  if ('contentIndex' in event) mapped.contentIndex = event.contentIndex
  if ('delta' in event) mapped.delta = event.delta
  if ('content' in event) mapped.content = event.content
  if ('partial' in event) mapped.partial = event.partial
  if ('message' in event) mapped.message = event.message
  if ('error' in event) mapped.error = event.error
  if ('toolCall' in event) {
    mapped.toolCall = {
      id: event.toolCall.id,
      name: event.toolCall.name,
      arguments: event.toolCall.arguments,
      ...(event.toolCall.namespace ? { namespace: event.toolCall.namespace } : {}),
    }
  }
  if ('reason' in event) mapped.reason = event.reason
  return mapped
}

function mapAgentEvent(event: AgentEvent): KernelAgentEvent<AgentMessage> {
  if (event.type === 'message_update') {
    return { ...event, assistantMessageEvent: mapAssistantMessageEvent(event.assistantMessageEvent) }
  }
  return event
}

/** Keep Pi's Agent constructor and loop lifecycle behind the kernel adapter. */
export function createPiKernelAgent(
  options: PiKernelAgentOptions,
  hooks: {
    beforeToolCall?: KernelBeforeToolCall
    afterToolCall?: KernelAfterToolCall<ToolAdapter<any, any>>
  } = {},
): PiKernelAgent {
  const beforeToolCall: AgentOptions['beforeToolCall'] = hooks.beforeToolCall
    ? async (context) => hooks.beforeToolCall?.({
        toolName: context.toolCall.name,
        input: (context.args ?? context.toolCall.arguments) as Record<string, unknown>,
      })
    : undefined
  let agent!: Agent
  let activeTools = [...(options.initialState?.tools ?? [])]
  const replaceTools = (tools: readonly ToolAdapter<any, any>[]) => {
    activeTools = [...tools]
    const piTools = activeTools.map(toPiAgentTool)
    agent.state.tools = piTools
    return piTools
  }
  const initialState = options.initialState
    ? {
        ...options.initialState,
        tools: activeTools.map(toPiAgentTool),
      }
    : undefined
  const afterToolCall: AgentOptions['afterToolCall'] = hooks.afterToolCall
    ? async (context) => {
        await hooks.afterToolCall?.({
          toolName: context.toolCall.name,
          setTools: (tools) => {
            context.context.tools = replaceTools(tools)
          },
        })
        return undefined
      }
    : undefined
  agent = new Agent({ ...options, initialState, beforeToolCall, afterToolCall })
  const snapshot = (): KernelAgentSnapshot<
    AgentMessage,
    Model<Api>,
    ToolAdapter<any, any>,
    ThinkingLevel
  > => ({
    systemPrompt: agent.state.systemPrompt,
    model: agent.state.model,
    thinkingLevel: agent.state.thinkingLevel,
    tools: [...activeTools],
    messages: [...agent.state.messages],
    isStreaming: agent.state.isStreaming,
    pendingToolCalls: new Set(agent.state.pendingToolCalls),
    errorMessage: agent.state.errorMessage,
  })

  return {
    getSnapshot: snapshot,
    getMessages: () => [...agent.state.messages],
    setMessages: (messages) => { agent.state.messages = [...messages] },
    setModel: (model) => { agent.state.model = model },
    setThinkingLevel: (level) => { agent.state.thinkingLevel = level },
    setTools: (tools) => { replaceTools(tools) },
    subscribe: (listener) => agent.subscribe((event, signal) => listener(mapAgentEvent(event), signal)),
    prompt: (message, images) => typeof message === 'string'
      ? agent.prompt(message, images?.map(toPiImageContent))
      : agent.prompt(message),
    steer: (message) => agent.steer(message),
    followUp: (message) => agent.followUp(message),
    abort: () => agent.abort(),
    waitForIdle: () => agent.waitForIdle(),
  }
}

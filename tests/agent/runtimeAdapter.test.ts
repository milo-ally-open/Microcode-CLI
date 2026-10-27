import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeAdapter } from '../../src/agent/contracts.ts'
import { MicrocodeAgent } from '../../src/agent/MicrocodeAgent.ts'
import type { KernelAgentEvent, KernelAgentPort, KernelAgentSnapshot } from '../../src/kernel/contracts.ts'
import type { CompactionMessageAdapter } from '../../src/session/contracts.ts'
import type { ToolAdapter } from '../../src/tools/contracts.ts'
import type { RuntimeModelSource } from '../../src/runtime/modelProjection.ts'
import type { RuntimeThinkingLevel } from '../../src/runtime/contracts.ts'
import { ensureBootstrapMacro } from '../../src/macro.ts'

interface TestMessage {
  role: 'system' | 'user'
  content: string
  timestamp: number
}

interface TestModel extends RuntimeModelSource {}

const testModel: TestModel = {
  id: 'small',
  provider: 'example',
  api: 'example-chat',
  name: 'Example Small',
  input: ['text'],
  contextWindow: 8192,
  maxTokens: 1024,
  reasoning: false,
}

const messageAdapter: CompactionMessageAdapter<TestMessage> = {
  getToolCalls: () => [],
  getToolResult: () => undefined,
  getTimestamp: (message) => message.timestamp,
  estimateTokens: (messages) => messages.length,
  formatMalformedUnit: (messages) => JSON.stringify(messages),
  createUserMessage: (content, timestamp) => ({ role: 'user', content, timestamp }),
  createSummaryMessage: (summary, timestamp) => ({ role: 'user', content: summary, timestamp }),
  replaceToolResultContent: (message) => message,
}

function createTestRuntime(): AgentRuntimeAdapter<TestMessage, TestModel> {
  return {
    getDefaultModelConfig: () => ({ model: testModel, apiKey: '' }),
    resolveModelConfig: () => ({ model: testModel, apiKey: '' }),
    resolveApiKey: () => undefined,
    supportsImages: () => false,
    describeModel: (model) => ({
      id: `${model.provider}/${model.id}`,
      provider_id: model.provider,
      model_id: model.id,
      api_id: model.api,
      name: model.name,
      input: [...model.input],
      context_window: model.contextWindow,
      max_output_tokens: model.maxTokens,
      reasoning: model.reasoning,
    }),
    modelPromptIdentity: (model) => `${model.provider}/${model.id}`,
    createKernel(setup) {
      let state: KernelAgentSnapshot<TestMessage, TestModel, ToolAdapter<any, any>, RuntimeThinkingLevel> = {
        systemPrompt: setup.systemPrompt,
        model: setup.model,
        thinkingLevel: 'off',
        tools: [...setup.tools],
        messages: [],
        isStreaming: false,
        pendingToolCalls: new Set(),
      }
      const port: KernelAgentPort<
        TestMessage,
        TestModel,
        ToolAdapter<any, any>,
        KernelAgentEvent<TestMessage>,
        RuntimeThinkingLevel
      > = {
        getSnapshot: () => state,
        getMessages: () => state.messages,
        setMessages: (messages) => { state = { ...state, messages: [...messages] } },
        setModel: (model) => { state = { ...state, model } },
        setThinkingLevel: (thinkingLevel) => { state = { ...state, thinkingLevel } },
        setTools: (tools) => { state = { ...state, tools: [...tools] } },
        subscribe: () => () => undefined,
        prompt: async (input) => {
          if (typeof input === 'string') {
            state = { ...state, messages: [...state.messages, { role: 'user', content: input, timestamp: Date.now() }] }
          }
        },
        steer: () => undefined,
        followUp: () => undefined,
        abort: () => undefined,
        waitForIdle: async () => undefined,
      }
      return port
    },
    getCompactionMessageAdapter: () => messageAdapter,
    createCompactionSummarizer: () => async () => ({ ok: true, value: 'summary' }),
    generateTitle: async () => 'Example title',
    isTaskReminderMessage: (message) => message.role === 'system' && message.content.startsWith('[task]'),
    createTaskReminderMessage: (reminder) => ({ role: 'system', content: `[task] ${reminder}`, timestamp: Date.now() }),
    toTokenEstimatorMessage: (message) => message,
    applySystemPrompt(messages, prompt) {
      const system = { role: 'system' as const, content: prompt, timestamp: Date.now() }
      return [system, ...messages.filter((message) => message.role !== 'system')]
    },
  }
}

describe('MicrocodeAgent runtime adapter contract', () => {
  test('runs with a non-Pi model and message implementation', async () => {
    ensureBootstrapMacro()
    const agent = new MicrocodeAgent<TestMessage, TestModel>(createTestRuntime(), { cwd: process.cwd() })

    expect(agent.getCurrentModel()).toEqual(testModel)
    expect(agent.getSnapshot().model.provider_id).toBe('example')
    await agent.prompt('hello from an alternate kernel')
    expect(agent.getMessages().some((message) =>
      message.role === 'user' && message.content === 'hello from an alternate kernel',
    )).toBe(true)
    expect(await agent.suggestSessionTitle('hello')).toBe('Example title')
  })
})

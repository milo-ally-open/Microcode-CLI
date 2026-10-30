import { describe, expect, test } from 'bun:test'
import type { RuntimeEventEnvelope } from '../../src/runtime/contracts.ts'
import type { RuntimeAgentSnapshot, RuntimeMessage } from '../../src/runtime/contracts.ts'
import { toTuiAgentEvent } from '../../src/tui/agentPort.ts'
import { RuntimeAgentFacade } from '../../src/tui/runtimeAgentFacade.ts'
import { RuntimeModelFacade } from '../../src/tui/runtimeModelFacade.ts'
import { ChatTranscript } from '../../src/tui/components/turnTimeline.ts'
import { App } from '../../src/tui/app.ts'

const capabilityEvent: RuntimeEventEnvelope = {
  protocol_version: 1,
  session_id: 'session-view',
  sequence: 7,
  type: 'capabilities_changed',
  payload: { mcp_server_count: 2 },
}

describe('runtime TUI view contract', () => {
  test('projects the complete runtime Agent event vocabulary into view events', () => {
    const userMessage: RuntimeMessage = { role: 'user', content: 'hello', timestamp: 1 }
    const assistantMessage: RuntimeMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      model: { provider_id: 'deepseek', model_id: 'deepseek-v4-pro', api_id: 'openai-completions' },
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost: 0 },
      stop_reason: 'stop',
      timestamp: 2,
    }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['agent_start', {}], ['agent_end', {}], ['turn_start', {}],
      ['capabilities_changed', {}], ['state_changed', { reason: 'skills_changed' }],
      ['compaction_changed', { progress: { phase: 'summarizing' } }],
      ['message_start', { message: userMessage }], ['message_start', { message: assistantMessage }],
      ['message_update', { message: assistantMessage, assistant_event: { type: 'text_delta', delta: 'hello' } }],
      ['message_end', { message: assistantMessage }],
      ['tool_execution_start', { tool_call_id: 'call-1', tool_id: 'read', arguments: { file_path: 'README.md' } }],
      ['tool_execution_update', { tool_call_id: 'call-1', tool_id: 'read', arguments: {}, partial_result: { content: [] } }],
      ['tool_execution_end', { tool_call_id: 'call-1', tool_id: 'read', result: { content: [] }, is_error: false }],
      ['turn_end', { message: assistantMessage }],
    ]

    for (const [type, payload] of cases) {
      const projected = toTuiAgentEvent({ type, payload })
      expect(projected?.type).toBe(type)
    }
    expect(toTuiAgentEvent({ type: 'message_start', payload: { message: { content: 'missing role' } } })).toBeUndefined()
  })

  test('projects runtime snapshots, token usage, skills, and instruction state into the view contract', () => {
    const usage = {
      requests: 1, input_tokens: 2, output_tokens: 3, cache_read_tokens: 0,
      cache_write_tokens: 0, total_tokens: 5, total_cost: 0,
    }
    const snapshot = {
      cwd: 'C:/workspace/project',
      model: {
        id: 'deepseek/deepseek-v4-pro', provider_id: 'deepseek', model_id: 'deepseek-v4-pro',
        api_id: 'openai-completions', name: 'DeepSeek V4 Pro', input: ['text'],
        context_window: 128000, max_output_tokens: 8192, reasoning: true,
      },
      thinking_level: 'high',
      messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      tokens: {
        context: {
          system_prompt_tokens: 10, message_tokens: 5, used_tokens: 15,
          remaining_tokens: 127985, context_window: 128000, percent_used: 0.01, percent_remaining: 99.99,
        },
        session: usage,
        current_model: { ...usage, key: 'deepseek/deepseek-v4-pro', model_id: 'deepseek-v4-pro', provider_id: 'deepseek', api_id: 'openai-completions' },
        by_model: {},
      },
      skills: {
        available: [{ name: 'sample-plugin:reviewer', description: 'Review code', scope: 'plugin', file_path: '/plugin/skills/reviewer/SKILL.md', base_dir: '/plugin/skills', disable_model_invocation: false, plugin_id: 'sample-plugin' }],
        diagnostics: [],
        loaded: [{ name: 'sample-plugin:reviewer' }],
      },
      project_instructions: { project_root: 'C:/workspace/project', working_directory: 'C:/workspace/project/src', files: [], diagnostics: [], total_bytes: 0 },
      capabilities: { plugins: [{ name: 'sample-plugin', enabled: true }] },
    } as unknown as RuntimeAgentSnapshot
    const fakeSession = {
      isConnected: true,
      signal: new AbortController().signal,
      snapshot,
      subscribe() { return () => undefined },
    }
    const facade = new RuntimeAgentFacade(fakeSession as never)

    expect(facade.getSnapshot()).toMatchObject({ cwd: 'C:/workspace/project', thinkingLevel: 'high', model: snapshot.model })
    expect(facade.getMessages()).toEqual(snapshot.messages)
    expect(facade.getTokenStats()).toMatchObject({
      context: { usedTokens: 15, remainingTokens: 127985 },
      currentModel: { provider: 'deepseek', modelId: 'deepseek-v4-pro', totalTokens: 5 },
    })
    expect(facade.getSkills()).toMatchObject([{ name: 'sample-plugin:reviewer', scope: 'plugin', pluginId: 'sample-plugin' }])
    expect(facade.isSkillLoaded('sample-plugin:reviewer')).toBe(true)
    expect(facade.getProjectInstructions()).toMatchObject({ workingDirectory: 'C:/workspace/project/src' })
    expect(facade.getRuntimeCapabilities()?.plugins).toEqual([{ name: 'sample-plugin', enabled: true }])
    facade.dispose()
  })

  test('projects capability scope changes to Agent view subscribers', () => {
    let callbacks: { onEvent?(event: RuntimeEventEnvelope): void } | undefined
    const fakeSession = {
      isConnected: true,
      signal: new AbortController().signal,
      snapshot: undefined,
      subscribe(value: typeof callbacks) {
        callbacks = value
        return () => undefined
      },
    }
    const facade = new RuntimeAgentFacade(fakeSession as never)
    const received: string[] = []
    facade.subscribe((event) => received.push(event.type))

    callbacks?.onEvent?.(capabilityEvent)

    expect(received).toEqual(['capabilities_changed'])
    facade.dispose()
  })

  test('invalidates the view when runtime capabilities change', () => {
    let listener: ((event: { type: string }) => void) | undefined
    let renders = 0
    let chatInvalidations = 0
    let footerInvalidations = 0
    const app = Object.create(App.prototype) as Record<string, unknown> & {
      setupAgentSubscription(): void
    }
    Object.assign(app, {
      agent: { subscribe: (next: typeof listener) => { listener = next; return () => undefined } },
      ui: { requestRender: () => { renders += 1 } },
      footer: { invalidate: () => { footerInvalidations += 1 } },
      invalidateChatRender: () => { chatInvalidations += 1 },
      permissionPromptActive: false,
      pendingEventsWhilePermission: [],
    })

    app.setupAgentSubscription()
    listener?.({ type: 'capabilities_changed' })

    expect(chatInvalidations).toBe(1)
    expect(footerInvalidations).toBe(1)
    expect(renders).toBe(1)
  })

  test('keeps runtime model auth prompts interactive and returns secret input only through the command', async () => {
    let callbacks: { onEvent?(event: RuntimeEventEnvelope): void } | undefined
    const commands: Array<{ type: string; payload: Record<string, unknown> }> = []
    const fakeSession = {
      subscribe(value: typeof callbacks) {
        callbacks = value
        return () => undefined
      },
      async sendCommand(type: string, payload: Record<string, unknown> = {}) {
        commands.push({ type, payload })
        if (type === 'model.auth.login') {
          queueMicrotask(() => callbacks?.onEvent?.({ ...capabilityEvent, type: 'model_auth_prompt', payload: {
            request_id: 'auth-request-1',
            prompt: { type: 'secret', message: 'Enter API key' },
          } }))
        }
        if (type === 'model.auth.prompt.resolve') {
          queueMicrotask(() => callbacks?.onEvent?.({ ...capabilityEvent, type: 'model_auth_complete', payload: { success: true } }))
        }
      },
    }
    const model = new RuntimeModelFacade(fakeSession as never)
    const prompted: string[] = []

    await model.login('deepseek', 'api_key', {
      signal: new AbortController().signal,
      prompt: async (prompt) => {
        prompted.push(`${prompt.type}:${prompt.message}`)
        return 'ui-entered-api-key'
      },
      notify: () => undefined,
    })

    expect(prompted).toEqual(['secret:Enter API key'])
    expect(commands.find((command) => command.type === 'model.auth.prompt.resolve')?.payload).toEqual({
      request_id: 'auth-request-1',
      value: 'ui-entered-api-key',
    })
    await model.dispose()
  })

  test('masks secret auth input in the terminal while submitting the entered value', async () => {
    let inputListener: ((data: string) => unknown) | undefined
    const transcript = new ChatTranscript()
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      chatContainer: transcript,
      editor: {},
      ui: {
        requestRender() {},
        setFocus() {},
        addInputListener(listener: (data: string) => unknown) {
          inputListener = listener
          return () => { inputListener = undefined }
        },
      },
      invalidateChatRender() {},
      lastSigintTime: 0,
    })

    const entered = app.promptAuthValue({ type: 'secret', message: 'Enter API key' }) as Promise<string>
    inputListener?.('my-key!!')
    const rendered = transcript.render(100).join('\n')
    expect(rendered).toContain('> ********')
    expect(rendered).not.toContain('my-key!!')
    inputListener?.('\n')
    expect(await entered).toBe('my-key!!')
    expect(transcript.render(100).join('\n')).not.toContain('my-key!!')
  })

  test('does not apply a Gateway bind change while the Agent is busy', async () => {
    let changedHost: string | undefined
    let status = ''
    const app = Object.create(App.prototype) as any
    Object.assign(app, {
      agent: { isBusy: () => true },
      gatewayBindControl: { setBindHost: async (host: string) => { changedHost = host } },
      showStatus(message: string) { status = message },
      showError() {},
    })

    await app.applyGatewayBindHost('0.0.0.0')

    expect(changedHost).toBeUndefined()
    expect(status).toContain('Agent became busy')
  })
})

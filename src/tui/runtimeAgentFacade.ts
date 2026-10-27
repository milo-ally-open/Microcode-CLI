import type { PermissionDecision, PermissionMode, PermissionSnapshot, EffectivePolicy } from '../permissions/types.ts'
import type { RuntimeAgentSnapshot, RuntimeMessage } from '../runtime/contracts.ts'
import type { TuiProjectInstructions } from './instructionsPort.ts'
import type { RuntimeClientSession } from '../runtime/client.ts'
import type { RuntimeEventEnvelope } from '../runtime/contracts.ts'
import { toTuiAgentEvent, type TuiAgentEventListener, type TuiAgentPort, type TuiAskUserQuestionHandler, type TuiCompactionResult, type TuiImageInput, type TuiPermissionRequestHandler, type TuiSkillSnapshot, type TuiTokenSnapshot, type TuiTokenUsage, type TuiModelTokenUsage, type TuiThinkingLevel } from './agentPort.ts'

interface PendingUiPermission {
  toolId: string
  input: Record<string, unknown>
  resolve(value: boolean): void
  reject(error: unknown): void
}

/** Compatibility adapter while the existing Chalk components migrate to runtime DTOs. */
export class RuntimeAgentFacade implements TuiAgentPort {
  private readonly listeners = new Set<TuiAgentEventListener>()
  private readonly pendingUiPermissions: PendingUiPermission[] = []
  private readonly promptWaiters = new Set<{ resolve(): void; reject(error: unknown): void }>()
  private readonly unsubscribeRuntime: () => void
  private readonly connectionListeners = new Set<(connected: boolean, error?: Error) => void>()
  private connected: boolean
  private permissionHandler?: TuiPermissionRequestHandler
  private questionHandler?: TuiAskUserQuestionHandler

  constructor(private readonly session: RuntimeClientSession) {
    this.connected = session.isConnected
    this.unsubscribeRuntime = session.subscribe({
      onEvent: (event) => this.onRuntimeEvent(event),
      onConnectionChange: (connected, error) => this.onConnectionChange(connected, error),
    })
  }

  dispose(): void {
    this.unsubscribeRuntime()
    this.listeners.clear()
    this.connectionListeners.clear()
    for (const waiter of this.promptWaiters) waiter.reject(new Error('Runtime client closed.'))
    this.promptWaiters.clear()
    for (const pending of this.pendingUiPermissions) pending.reject(new Error('Runtime client closed.'))
    this.pendingUiPermissions.length = 0
  }

  getSnapshot(): ReturnType<TuiAgentPort['getSnapshot']> {
    const snapshot = this.requireSnapshot()
    const tokens = toTokenStats(snapshot)
    return Object.freeze({
      cwd: snapshot.cwd,
      model: snapshot.model,
      thinkingLevel: snapshot.thinking_level,
      tokens: Object.freeze({
        context: tokens.context,
        session: tokens.session,
      }),
    })
  }

  getRuntimeCapabilities(): RuntimeAgentSnapshot['capabilities'] | undefined {
    return this.session.snapshot?.capabilities
  }

  subscribeRuntimeConnection(listener: (connected: boolean, error?: Error) => void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  getMessages(): readonly RuntimeMessage[] {
    return this.requireSnapshot().messages
  }

  getCurrentModel(): RuntimeAgentSnapshot['model'] {
    return this.requireSnapshot().model
  }

  isBusy(): boolean {
    const snapshot = this.requireSnapshot()
    return snapshot.is_streaming || snapshot.pending_tool_call_count > 0
  }

  async prompt(input: string, images?: readonly TuiImageInput[]): Promise<void> {
    return this.promptCommand('prompt', input, images)
  }

  async promptReadOnly(input: string): Promise<void> {
    return this.promptCommand('prompt.read_only', input)
  }

  abort(): void {
    void this.session.sendCommand('abort').catch(() => undefined)
  }

  subscribe(listener: TuiAgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getTokenStats(): Readonly<TuiTokenSnapshot> {
    return toTokenStats(this.requireSnapshot())
  }

  async compact(options: { instructions?: string; persistToSession?: boolean } = {}): Promise<Readonly<TuiCompactionResult>> {
    const result = await this.session.sendCommand<TuiCompactionResult>('session.compact', {
      ...(options.instructions ? { instructions: options.instructions } : {}),
    })
    return Object.freeze({
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      keptMessageCount: result.keptMessageCount,
      automatic: result.automatic,
    })
  }

  async persistMessages(): Promise<void> {
    // The runtime persists turns and compaction records as the sole session writer.
  }

  async clearMessages(): Promise<void> {
    await this.session.sendCommand('session.clear')
  }

  async setThinkingLevel(level: TuiThinkingLevel): Promise<void> {
    await this.session.sendCommand('thinking.set', { level })
  }

  getPermissionMode(): PermissionMode {
    return this.requireSnapshot().permission.mode as PermissionMode
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.session.sendCommand('permission.set', { mode })
  }

  async checkPermission(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    return this.session.sendCommand('permission.check', { tool_id: toolName, input })
  }

  async requestToolPermission(toolName: string, input: Record<string, unknown>, description: string): Promise<boolean> {
    const result = new Promise<boolean>((resolve, reject) => {
      this.pendingUiPermissions.push({ toolId: toolName, input, resolve, reject })
    })
    try {
      await this.session.sendCommand('permission.request', { tool_id: toolName, input, description })
    } catch (error) {
      const index = this.pendingUiPermissions.findIndex((pending) => pending.toolId === toolName && sameJson(pending.input, input))
      if (index >= 0) this.pendingUiPermissions.splice(index, 1)[0]?.reject(error)
    }
    return result
  }

  addSessionPermission(toolName: string, ruleContent?: string): void {
    void this.session.sendCommand('permission.rule.add', {
      tool_id: toolName,
      ...(ruleContent === undefined ? {} : { rule_content: ruleContent }),
    }).catch(() => undefined)
  }

  setPermissionRequestHandler(handler: TuiPermissionRequestHandler): void {
    this.permissionHandler = handler
  }

  setAskUserQuestionHandler(handler: TuiAskUserQuestionHandler): void {
    this.questionHandler = handler
  }

  getSkillSnapshot(): Readonly<TuiSkillSnapshot> {
    const skills = this.requireSnapshot().skills
    return Object.freeze({
      available: Object.freeze(skills.available.map((skill) => Object.freeze({
        name: skill.name,
        description: skill.description,
        scope: skill.scope as import('../skill.ts').SkillScope,
        filePath: skill.file_path,
        baseDir: skill.base_dir,
        disableModelInvocation: skill.disable_model_invocation,
        ...(skill.plugin_id ? { pluginId: skill.plugin_id } : {}),
      }))),
      diagnostics: Object.freeze([...skills.diagnostics]),
      loaded: Object.freeze(skills.loaded.map((skill) => Object.freeze({ name: skill.name, body: '' }))),
    })
  }

  getSkills(): ReturnType<TuiAgentPort['getSkills']> {
    return this.getSkillSnapshot().available
  }

  isSkillLoaded(skillName: string): boolean {
    return this.requireSnapshot().skills.loaded.some((skill) => skill.name === skillName)
  }

  loadSkill(skillName: string): void {
    void this.session.sendCommand('skill.set', { skill_id: skillName, enabled: true }).catch(() => undefined)
  }

  unloadSkill(skillName: string): void {
    void this.session.sendCommand('skill.set', { skill_id: skillName, enabled: false }).catch(() => undefined)
  }

  refreshSystemPrompt(): void {
    // Prompt state is rebuilt by the runtime after its own skill/session commands.
  }

  getProjectInstructions(): TuiProjectInstructions | undefined {
    const instructions = this.requireSnapshot().project_instructions
    return {
      projectRoot: instructions.project_root,
      workingDirectory: instructions.working_directory,
      files: instructions.files.map((file) => ({ ...file })),
      diagnostics: [...instructions.diagnostics],
      totalBytes: instructions.total_bytes,
    }
  }

  getEffectivePolicy(): Readonly<EffectivePolicy> {
    const policy = this.requireSnapshot().effective_policy
    return Object.freeze({
      approvalMode: policy.approval_mode as EffectivePolicy['approvalMode'],
      rules: policy.rules.map((rule) => ({
        toolName: rule.tool_id,
        ruleContent: rule.rule_content,
        behavior: rule.behavior as PermissionSnapshot['allowRules'][number]['behavior'],
        source: rule.source as PermissionSnapshot['allowRules'][number]['source'],
      })),
    })
  }

  private async promptCommand(type: 'prompt' | 'prompt.read_only', input: string, images?: readonly TuiImageInput[]): Promise<void> {
    const waiter = new Promise<void>((resolve, reject) => this.promptWaiters.add({ resolve, reject }))
    try {
      await this.session.sendCommand(type, {
        text: input,
        ...(images?.length ? { images: images.map((image) => ({ type: 'image', data: image.data, mime_type: image.mimeType })) } : {}),
      })
    } catch (error) {
      const first = this.promptWaiters.values().next().value as { resolve(): void; reject(error: unknown): void } | undefined
      if (first) this.promptWaiters.delete(first)
      throw error
    }
    return waiter
  }

  private onRuntimeEvent(event: RuntimeEventEnvelope): void {
    const converted = toTuiAgentEvent(event)
    if (converted) {
      for (const listener of [...this.listeners]) {
        try { void listener(converted, this.session.signal) } catch { /* A view listener cannot interrupt runtime event delivery. */ }
      }
    }
    if (event.type === 'permission_requested') void this.handlePermissionRequested(event.payload)
    if (event.type === 'turn_end') {
      const message = event.payload.message as RuntimeMessage | undefined
      if (message?.role === 'assistant' && message.stop_reason !== 'toolUse') {
        const waiter = this.promptWaiters.values().next().value as { resolve(): void; reject(error: unknown): void } | undefined
        if (waiter) {
          this.promptWaiters.delete(waiter)
          if (message.stop_reason === 'error') waiter.reject(new Error('Agent turn failed.'))
          else waiter.resolve()
        }
      }
    }
    if (event.type === 'runtime_error') {
      const waiter = this.promptWaiters.values().next().value as { resolve(): void; reject(error: unknown): void } | undefined
      if (waiter) {
        this.promptWaiters.delete(waiter)
        waiter.reject(new Error('Runtime Agent turn failed.'))
      }
    }
  }

  private onConnectionChange(connected: boolean, error?: Error): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const listener of [...this.connectionListeners]) {
      try { listener(connected, error) } catch { /* A view callback cannot interfere with reconnects. */ }
    }
  }

  private async handlePermissionRequested(payload: Record<string, unknown>): Promise<void> {
    const request = payload.request as Record<string, unknown> | undefined
    if (!request || typeof request.request_id !== 'string' || typeof request.tool_id !== 'string') return
    const requestId = request.request_id
    const toolId = request.tool_id
    const input = isRecord(request.input) ? request.input : {}
    if (request.kind === 'question') {
      const answer: { answers?: Record<string, string>; block?: boolean } = await this.questionHandler?.(toolId, input, requestId).catch(() => ({ block: true })) ?? { block: true }
      await this.session.sendCommand('question.resolve', {
        request_id: requestId,
        ...(answer.answers ? { answers: answer.answers } : {}),
        ...(answer.block === undefined ? {} : { block: answer.block }),
      }).catch(() => undefined)
      return
    }
    const pendingIndex = this.pendingUiPermissions.findIndex((pending) => pending.toolId === toolId && sameJson(pending.input, input))
    const pending = pendingIndex >= 0 ? this.pendingUiPermissions.splice(pendingIndex, 1)[0] : undefined
    let allowed = false
    const preview = isRecord(request.preview) ? request.preview : undefined
    try { allowed = await this.permissionHandler?.(toolId, input, String(request.description ?? ''), requestId, preview) ?? false } catch {}
    pending?.resolve(allowed)
    await this.session.sendCommand('permission.resolve', { request_id: requestId, allowed }).catch(() => undefined)
  }

  private requireSnapshot(): RuntimeAgentSnapshot {
    const snapshot = this.session.snapshot
    if (!snapshot) throw new Error('Runtime snapshot has not been loaded.')
    return snapshot
  }
}

function toTokenStats(snapshot: RuntimeAgentSnapshot): Readonly<TuiTokenSnapshot> {
  const usage = (value: { requests: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number; total_cost: number }): TuiTokenUsage => ({
    requests: value.requests,
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    cacheReadTokens: value.cache_read_tokens,
    cacheWriteTokens: value.cache_write_tokens,
    totalTokens: value.total_tokens,
    totalCost: value.total_cost,
  })
  const modelUsage = (value: RuntimeAgentSnapshot['tokens']['current_model']): TuiModelTokenUsage => ({
    ...usage(value),
    key: value.key,
    modelId: value.model_id,
    provider: value.provider_id,
    api: value.api_id,
  })
  return Object.freeze({
    context: Object.freeze({
      systemPromptTokens: snapshot.tokens.context.system_prompt_tokens,
      messageTokens: snapshot.tokens.context.message_tokens,
      usedTokens: snapshot.tokens.context.used_tokens,
      remainingTokens: snapshot.tokens.context.remaining_tokens,
      contextWindow: snapshot.tokens.context.context_window,
      percentUsed: snapshot.tokens.context.percent_used,
      percentRemaining: snapshot.tokens.context.percent_remaining,
    }),
    session: Object.freeze(usage(snapshot.tokens.session)),
    currentModel: Object.freeze(modelUsage(snapshot.tokens.current_model)),
    byModel: Object.freeze(Object.fromEntries(Object.entries(snapshot.tokens.by_model).map(([key, entry]) => [key, Object.freeze(modelUsage(entry))]))),
  })
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sameJson(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

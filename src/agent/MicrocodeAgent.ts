import {
  getDeferredToolNames,
  BASH_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  VISION_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  TOOL_CONTROL_TOOL_NAME,
} from '../tools/index.ts'
import { getSystemPrompt } from '../prompt/prompts.ts'
import { CompactionManager } from '../session/CompactionManager.ts'
import type { ProjectInstructions } from '../instructions/projectInstructions.ts'
import type { McpServerState } from '../mcp/types.ts'
import type { McpClientManager } from '../mcp/client.ts'
import type { KernelAgentEvent, KernelAgentPort } from '../kernel/contracts.ts'
import type { ToolAdapter } from '../tools/contracts.ts'
import type { RuntimeImageInput, RuntimeThinkingLevel } from '../runtime/contracts.ts'
import type { RuntimeModelSource } from '../runtime/modelProjection.ts'
import type { AgentRuntimeAdapter } from './contracts.ts'
import { AgentTokenTracker, type AgentTokenSnapshot } from './AgentTokenTracker.ts'
import {
  AgentModelManager,
  type AgentModelSnapshot,
} from './AgentModelManager.ts'
import { AgentToolManager, AgentToolSnapshotConflictError, type AgentToolSnapshot } from './AgentToolManager.ts'
import { AgentSkillManager, type AgentSkillSnapshot } from './AgentSkillManager.ts'
import {
  PermissionManager,
  type PermissionBehavior,
  type EffectivePolicy,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleValue,
  type PermissionSnapshot,
} from '../permissions/index.ts'
import type {
  AgentCompactionResult,
  AgentPermissionConfig,
  AgentPermissionRequest,
  AgentStateChangeReason,
  AgentIdentity,
  CompactAgentOptions,
  CreateMicrocodeAgentOptions,
  MessageUsageResetMode,
  MicrocodeAgentEvent,
  MicrocodeAgentEventListener,
  MicrocodeAgentSnapshot,
} from './types.ts'
import type {
  AgentCompactionRecord,
  AgentSessionPersistence,
} from './persistence.ts'
import { resolve } from 'node:path'
import { buildWorkspaceFileContext, listWorkspaceFiles } from '../utils/workspaceFileReferences.ts'
import { buildSkillMentionContext } from '../skill/promptContext.ts'

function createAgentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const COMPACTABLE_TOOL_NAMES = new Set([
  BASH_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  VISION_TOOL_NAME,
])

function normalizeIdentity<Message, Model extends RuntimeModelSource>(
  options: CreateMicrocodeAgentOptions<Message, Model>,
): Readonly<AgentIdentity> {
  return Object.freeze({
    id: options.identity?.id ?? createAgentId(),
    name: options.identity?.name,
    role: options.identity?.role,
  })
}

/**
 * High-level runtime boundary for one Microcode agent instance.
 *
 * The underlying pi-agent-core Agent stays private. All runtime mutations and
 * lifecycle observations go through this instance boundary.
 */
export class MicrocodeAgent<
  Message = unknown,
  Model extends RuntimeModelSource = RuntimeModelSource,
> {
  private readonly core: KernelAgentPort<Message, Model, ToolAdapter<any, any>, KernelAgentEvent<Message>, RuntimeThinkingLevel, RuntimeImageInput>
  private readonly identity: Readonly<AgentIdentity>
  private readonly cwd: string
  private readonly compactionManager: CompactionManager<Message>
  private readonly permissionManager: PermissionManager
  private readonly tokenTracker = new AgentTokenTracker()
  private readonly modelManager: AgentModelManager<Model>
  private readonly toolManager: AgentToolManager
  private readonly skillManager: AgentSkillManager
  private readonly pluginPromptContext?: CreateMicrocodeAgentOptions['pluginPromptContext']
  private baseSystemPrompt: string
  private projectInstructions?: ProjectInstructions
  private mcpServers?: McpServerState[]
  private persistence?: AgentSessionPersistence<Message>
  private readonly listeners = new Set<MicrocodeAgentEventListener<Message>>()
  private readonly eventController = new AbortController()
  private permissionRequestHandler?: AgentPermissionConfig['onPermissionRequest']
  private askUserQuestionHandler?: AgentPermissionConfig['onAskUserQuestion']
  constructor(
    private readonly runtime: AgentRuntimeAdapter<Message, Model>,
    options: CreateMicrocodeAgentOptions<Message, Model> = {},
  ) {
    this.cwd = options.cwd ?? process.cwd()
    this.projectInstructions = options.projectInstructions
    this.persistence = options.persistence
    this.pluginPromptContext = options.pluginPromptContext
    this.identity = normalizeIdentity(options)
    this.permissionRequestHandler = options.permission?.onPermissionRequest
    this.askUserQuestionHandler = options.permission?.onAskUserQuestion
    this.permissionManager = new PermissionManager({
      mode: options.permission?.mode,
      allowedTools: options.permission?.allow,
      deniedTools: options.permission?.deny,
      askTools: options.permission?.ask,
      onPermissionRequest: this.permissionRequestHandler
        ? (toolName, input, description) =>
            this.handlePermissionRequest('tool', toolName, input, description)
        : undefined,
      onAskUserQuestion: this.askUserQuestionHandler
        ? (toolName, input) => this.handleQuestionRequest(toolName, input)
        : undefined,
    })

    const resolveModelConfig = options.resolveModelConfig
      ?? ((modelId: string, api?: string, provider?: string) =>
        this.runtime.resolveModelConfig(modelId, api, provider))
    const modelConfig = options.initialModelConfig
      ?? (options.modelId
        ? resolveModelConfig(options.modelId, options.api)
        : this.runtime.getDefaultModelConfig())
    this.modelManager = new AgentModelManager({
      model: modelConfig.model,
      apiKey: modelConfig.apiKey,
      thinkingLevel: options.thinkingLevel,
      resolveModelConfig,
      resolveApiKey: options.resolveModelApiKey ?? this.runtime.resolveApiKey,
    })
    this.mcpServers = options.mcpServers ? [...options.mcpServers] : undefined
    this.skillManager = new AgentSkillManager({
      cwd: this.cwd,
      skillPaths: options.skillPaths ?? [],
      includeDefaults: true,
      pluginSkills: options.pluginSkills,
      pluginDiagnostics: options.pluginDiagnostics,
    })
    this.toolManager = new AgentToolManager({
      cwd: this.cwd,
      getSkills: () => this.skillManager.getSkills(),
      modelSupportsImages: this.runtime.supportsImages(modelConfig.model),
      getPersistence: () => this.persistence,
    })

    const deferredToolNames = getDeferredToolNames()
    const systemPrompt = getSystemPrompt({
      cwd: this.cwd,
      modelId: this.runtime.modelPromptIdentity(modelConfig.model),
      mcpServers: this.mcpServers,
      skills: [...this.skillManager.getSkills()],
      deferredToolNames: deferredToolNames.length > 0 ? deferredToolNames : undefined,
      projectInstructions: this.projectInstructions,
    }).join('\n\n')

    this.baseSystemPrompt = systemPrompt
    this.compactionManager = new CompactionManager<Message>({
      contextWindow: modelConfig.model.contextWindow,
      messageAdapter: this.runtime.getCompactionMessageAdapter(),
      compactableToolNames: COMPACTABLE_TOOL_NAMES,
      summarize: options.summarize ?? this.runtime.createCompactionSummarizer(
        () => this.modelManager.getModel(),
      ),
      onProgress: (progress) => {
        options.onCompactionProgress?.(progress)
        this.emitDetached({
          type: 'compaction_changed',
          agentId: this.identity.id,
          progress: Object.freeze({ ...progress }),
        })
      },
      settings: options.compactionSettings,
    })
    this.compactionManager.setSystemPrompt(this.baseSystemPrompt)

    this.core = this.runtime.createKernel({
      systemPrompt: this.baseSystemPrompt,
      model: modelConfig.model,
      getCurrentModel: () => this.modelManager.getModel(),
      tools: this.getActiveTools(),
      // prepareRequest can replace the loop's current context. transformContext
      // only projects a one-request copy, so compaction there leaves subsequent
      // tool/model turns running on the original oversized transcript.
      prepareRequest: (messages) => this.prepareModelContext(messages),
    }, {
      beforeToolCall: (request) => this.permissionManager.checkPermissionWithPrompt(request),
      afterToolCall: ({ toolName, setTools }) => {
        if (toolName !== TOOL_SEARCH_TOOL_NAME && toolName !== TOOL_CONTROL_TOOL_NAME) return
        const changes = this.toolManager.commitPendingChanges()
        if (!changes.changed) return
        setTools(this.getActiveTools())
        this.emitStateChangedDetached('tools_changed')
      },
    })

    if (options.thinkingLevel) {
      this.core.setThinkingLevel(options.thinkingLevel)
    }
    this.modelManager.setThinkingLevel(this.core.getSnapshot().thinkingLevel)

    this.permissionManager.setGetTool((name: string) =>
      this.toolManager.findTool(name),
    )
    this.core.subscribe(async (event, signal) => {
      if (event.type === 'message_end') {
        this.tokenTracker.recordMessage(event.message)
      }
      await this.emit({ ...event, agentId: this.identity.id }, signal)
      if (event.type === 'tool_execution_start') {
        await this.emit({
          type: 'tool_started',
          agentId: this.identity.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }, signal)
      } else if (event.type === 'tool_execution_end') {
        await this.emit({
          type: 'tool_finished',
          agentId: this.identity.id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        }, signal)
      }
      if (event.type === 'message_end') {
        await this.emitTokenUsage(signal)
      }
      if (
        event.type === 'agent_start' ||
        event.type === 'agent_end' ||
        event.type === 'turn_end' ||
        event.type === 'message_end' ||
        event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_end'
      ) {
        await this.emitStateChanged('core_event', signal)
      }
    })
  }

  getId(): string {
    return this.identity.id
  }

  getIdentity(): Readonly<AgentIdentity> {
    return this.identity
  }

  getSnapshot(): Readonly<MicrocodeAgentSnapshot> {
    const state = this.core.getSnapshot()
    const modelConfig = this.modelManager.getSnapshot()
    return Object.freeze({
      identity: this.identity,
      cwd: this.cwd,
      model: modelConfig.model,
      modelConfig,
      thinkingLevel: state.thinkingLevel,
      systemPrompt: state.systemPrompt,
      messageCount: state.messages.length,
      toolNames: Object.freeze(state.tools.map((tool) => tool.name)),
      tools: this.toolManager.getSnapshot(),
      skills: this.skillManager.getSnapshot(),
      isStreaming: state.isStreaming,
      pendingToolCallCount: state.pendingToolCalls.size,
      permission: this.permissionManager.getSnapshot(),
      effectivePolicy: this.permissionManager.getEffectivePolicy(),
      tokens: this.getTokenStats(),
      errorMessage: state.errorMessage,
    })
  }

  getMessages(): readonly Message[] {
    return this.core.getMessages()
  }

  isBusy(): boolean {
    const snapshot = this.core.getSnapshot()
    return snapshot.isStreaming || snapshot.pendingToolCalls.size > 0
  }

  getCurrentModel(): Readonly<Model> {
    return Object.freeze({ ...this.modelManager.getModel() })
  }

  getThinkingLevel(): RuntimeThinkingLevel {
    return this.modelManager.getThinkingLevel()
  }

  replaceMessages(
    messages: readonly Message[],
    usageMode: MessageUsageResetMode = 'rebuild',
  ): void {
    this.core.setMessages(messages)
    if (usageMode === 'rebuild') {
      this.tokenTracker.rebuild(messages)
    } else {
      this.tokenTracker.recordMessages(messages)
    }
    this.emitTokenAndState('messages_replaced')
  }

  clearMessages(): void {
    this.core.setMessages([])
    this.tokenTracker.reset()
    this.emitTokenAndState('messages_cleared')
  }

  getTokenStats(): Readonly<AgentTokenSnapshot> {
    const state = this.core.getSnapshot()
    return this.tokenTracker.getSnapshot({
      systemPrompt: state.systemPrompt,
      messages: state.messages.map((message) => this.runtime.toTokenEstimatorMessage(message)),
      model: state.model,
    })
  }

  prompt(message: Message | Message[]): Promise<void>
  prompt(input: string, images?: RuntimeImageInput[]): Promise<void>
  async prompt(
    input: string | Message | Message[],
    images?: RuntimeImageInput[],
  ): Promise<void> {
    this.refreshSkillCatalog()
    if (!this.isBusy()) await this.compactIfNeeded()
    if (typeof input === 'string') {
      await this.core.prompt(await this.preparePromptContext(input), images)
    } else {
      await this.core.prompt(input)
    }
    await this.compactAfterPrompt()
  }

  async promptReadOnly(input: string): Promise<void> {
    if (this.isBusy()) throw new Error('Cannot change the available tools while the agent is busy.')

    this.refreshSkillCatalog()
    await this.compactIfNeeded()
    this.toolManager.setPromptReadOnly(true)
    this.core.setTools(this.getActiveTools())
    this.emitStateChangedDetached('tools_changed')
    try {
      await this.core.prompt(await this.preparePromptContext(input))
    } finally {
      this.toolManager.setPromptReadOnly(false)
      this.core.setTools(this.getActiveTools())
      this.emitStateChangedDetached('tools_changed')
    }
    await this.compactAfterPrompt()
  }

  abort(): void {
    this.core.abort()
  }

  followUp(message: Message): void {
    this.core.followUp(message)
  }

  steer(message: Message): void {
    this.core.steer(message)
  }

  waitForIdle(): Promise<void> {
    return this.core.waitForIdle()
  }

  subscribe(listener: MicrocodeAgentEventListener<Message>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setThinkingLevel(level: RuntimeThinkingLevel): void {
    this.modelManager.setThinkingLevel(level)
    this.core.setThinkingLevel(level)
    this.emitStateChangedDetached('thinking_changed')
  }

  getModelSnapshot(): Readonly<AgentModelSnapshot> {
    return this.modelManager.getSnapshot()
  }

  getApiKey(): string {
    return this.modelManager.getApiKey()
  }

  async suggestSessionTitle(openingSentence: string): Promise<string> {
    return this.runtime.generateTitle(this.modelManager.getModel(), openingSentence)
  }

  switchModel(modelId: string, api?: string, provider?: string): Readonly<AgentModelSnapshot> {
    const nextConfig = this.modelManager.resolve(modelId, api, provider)
    const nextCoreTools = this.toolManager.previewCoreTools(this.runtime.supportsImages(nextConfig.model))
    const nextBasePrompt = this.buildBaseSystemPrompt(nextConfig.model)
    const nextPrompt = this.appendLoadedSkills(nextBasePrompt)

    const previousConfig = {
      model: this.modelManager.getModel(),
      apiKey: this.modelManager.getApiKey(),
    }
    const previousState = this.core.getSnapshot()
    const previousModel = previousState.model
    const previousCoreTools = this.toolManager.getCoreTools()
    const previousPrompt = previousState.systemPrompt
    const previousBasePrompt = this.baseSystemPrompt

    try {
      this.modelManager.commit(nextConfig)
      this.core.setModel(nextConfig.model)
      this.toolManager.replaceCoreTools(nextCoreTools)
      this.core.setTools(this.getActiveTools())
      this.baseSystemPrompt = nextBasePrompt
      this.updateSystemPrompt(nextPrompt)
      this.compactionManager.setContextWindow(nextConfig.model.contextWindow)
      this.compactionManager.setSystemPrompt(nextPrompt)
      const snapshot = this.modelManager.getSnapshot()
      this.emitDetached({
        type: 'model_changed',
        agentId: this.identity.id,
        previous: this.runtime.describeModel(previousModel),
        current: snapshot.model,
      })
      this.emitTokenAndState('model_changed')
      return snapshot
    } catch (error) {
      this.modelManager.commit(previousConfig)
      this.core.setModel(previousModel)
      this.toolManager.replaceCoreTools(previousCoreTools)
      this.core.setTools(this.getActiveTools())
      this.baseSystemPrompt = previousBasePrompt
      this.updateSystemPrompt(previousPrompt)
      this.compactionManager.setContextWindow(previousModel.contextWindow)
      this.compactionManager.setSystemPrompt(previousPrompt)
      throw error
    }
  }

  updateMcpServers(servers?: McpServerState[]): void {
    this.mcpServers = servers ? [...servers] : undefined
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.getSnapshot().model)
    const prompt = this.appendLoadedSkills(this.baseSystemPrompt)
    this.updateSystemPrompt(prompt)
    this.compactionManager.setSystemPrompt(prompt)
    this.emitTokenAndState('system_prompt_changed')
  }

  refreshSystemPrompt(): void {
    const prompt = this.appendLoadedSkills(this.baseSystemPrompt)
    this.updateSystemPrompt(prompt)
    this.compactionManager.setSystemPrompt(prompt)
    this.emitTokenAndState('system_prompt_changed')
  }

  getPermissionMode(): PermissionMode {
    return this.permissionManager.getMode()
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionManager.setMode(mode)
    this.emitStateChangedDetached('permission_changed')
  }

  getEffectivePolicy(): Readonly<EffectivePolicy> {
    return this.permissionManager.getEffectivePolicy()
  }

  getPermissionSnapshot(): Readonly<PermissionSnapshot> {
    return this.permissionManager.getSnapshot()
  }

  checkPermission(
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionDecision {
    return this.permissionManager.checkPermission(toolName, input)
  }

  requestToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ): Promise<boolean> {
    return this.handlePermissionRequest('tool', toolName, input, description)
  }

  addPermissionRule(rule: PermissionRule): void {
    this.permissionManager.addRule(rule)
    this.emitStateChangedDetached('permission_changed')
  }

  removePermissionRule(
    rule: PermissionRuleValue,
    behavior: PermissionBehavior,
  ): void {
    this.permissionManager.removeRule(rule, behavior)
    this.emitStateChangedDetached('permission_changed')
  }

  addSessionPermission(toolName: string, ruleContent?: string): void {
    this.permissionManager.addSessionRule(toolName, ruleContent)
    this.emitStateChangedDetached('permission_changed')
  }

  /** Replace all rules from a parent snapshot (permission inheritance). */
  inheritPermissions(
    snapshot: Readonly<PermissionSnapshot>,
    extraDeny: PermissionRuleValue[] = [],
    updateMode = true,
  ): void {
    this.permissionManager.inheritFrom(snapshot, extraDeny, updateMode)
  }

  setPermissionRequestHandler(
    handler: AgentPermissionConfig['onPermissionRequest'],
  ): void {
    this.permissionRequestHandler = handler
    this.permissionManager.setOnPermissionRequest((toolName, input, description) =>
      this.handlePermissionRequest('tool', toolName, input, description),
    )
  }

  setAskUserQuestionHandler(
    handler: AgentPermissionConfig['onAskUserQuestion'],
  ): void {
    this.askUserQuestionHandler = handler
    this.permissionManager.setOnAskUserQuestion((toolName, input) =>
      this.handleQuestionRequest(toolName, input),
    )
  }

  setPersistence(persistence?: AgentSessionPersistence<Message>): void {
    this.persistence = persistence
  }

  async persistMessages(): Promise<void> {
    await this.persistence?.saveMessages(this.core.getMessages())
  }

  async compact(options: CompactAgentOptions = {}): Promise<Readonly<AgentCompactionResult<Message>>> {
    if (this.core.getSnapshot().isStreaming) {
      throw new Error('Cannot manually compact while the agent is running.')
    }
    const messages = [...this.core.getMessages()]
    if (messages.length === 0) {
      throw new Error('No messages to compact.')
    }
    const result = await this.compactionManager.compact(
      messages,
      options.instructions,
      false,
    )
    await this.commitCompaction(result, options.persistToSession !== false)
    return Object.freeze({
      ...result,
      messages: Object.freeze([...result.messages]),
    })
  }

  async compactIfNeeded(
    messages: readonly Message[] = this.core.getMessages(),
  ): Promise<Message[]> {
    const originalUsage = this.compactionManager.getContextUsage([...messages])
    const contextWindowExceeded = originalUsage.tokens > originalUsage.contextWindow
    const { messages: microcompacted } = this.compactionManager.microcompact([...messages])
    if (
      !contextWindowExceeded &&
      !this.compactionManager.isCompactionNeeded(microcompacted)
    ) {
      return microcompacted
    }
    try {
      const result = await this.compactionManager.compact(
        microcompacted,
        undefined,
        true,
      )
      await this.commitCompaction(result, true)
      return result.messages
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Automatic context compaction failed: ${message}`, { cause: error })
    }
  }

  private async compactAfterPrompt(): Promise<void> {
    // A failed pre-request compaction already ended the core run with a visible error.
    // Do not immediately retry the same failing summary request after that run settles.
    if (this.core.getSnapshot().errorMessage?.startsWith('Automatic context compaction failed:')) return
    await this.compactIfNeeded()
  }

  private async addMentionedFileContext(input: string): Promise<string> {
    if (!input.includes('@')) return input
    const indexedFiles = new Set(await listWorkspaceFiles(this.cwd))
    return buildWorkspaceFileContext(this.cwd, input, indexedFiles, async (path) => {
      const decision = await this.permissionManager.checkPermissionWithPrompt({
        toolName: FILE_READ_TOOL_NAME,
        input: { file_path: resolve(this.cwd, path) },
      })
      return decision === undefined
    })
  }

  private async preparePromptContext(input: string): Promise<string> {
    const scanText = input
    const skillContext = buildSkillMentionContext(
      input,
      this.skillManager.getSkills().filter((skill) => !this.skillManager.isLoaded(skill.name)),
      scanText,
    )
    const pluginContext = this.pluginPromptContext?.(skillContext, scanText) ?? skillContext
    return this.addMentionedFileContext(pluginContext)
  }

  private async prepareModelContext(
    messages: readonly Message[],
  ): Promise<Message[]> {
    // The prepared context is carried into the next request by the Agent loop.
    // Replace, rather than accumulate, the transient reminder each time.
    const withoutPreviousReminder = messages.filter((message) =>
      !this.runtime.isTaskReminderMessage(message),
    )
    const compacted = await this.compactIfNeeded(withoutPreviousReminder)
    const reminder = await this.getTaskReminder()
    if (!reminder) return compacted

    return [...compacted, this.runtime.createTaskReminderMessage(reminder)]
  }

  private async getTaskReminder(): Promise<string | undefined> {
    try {
      return await this.persistence?.getTaskReminder?.()
    } catch {
      // A reminder must never prevent the agent from continuing.
      return undefined
    }
  }

  getSkillSnapshot(): Readonly<AgentSkillSnapshot> {
    this.refreshSkillCatalog()
    return this.skillManager.getSnapshot()
  }

  getSkills() {
    this.refreshSkillCatalog()
    return this.skillManager.getSkills()
  }

  isSkillLoaded(skillName: string): boolean {
    this.refreshSkillCatalog()
    return this.skillManager.isLoaded(skillName)
  }

  getLoadedSkillNames(): readonly string[] {
    return this.skillManager.getLoadedNames()
  }

  loadSkill(skillName: string): void {
    this.refreshSkillCatalog()
    this.skillManager.load(skillName)
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  unloadSkill(skillName: string): void {
    this.refreshSkillCatalog()
    if (!this.skillManager.unload(skillName)) return
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  setPluginSkills(skills: readonly import('../skill.ts').Skill[], diagnostics: readonly string[] = []): void {
    if (!this.skillManager.setPluginSkills(skills, diagnostics)) return
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.getSnapshot().model)
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  getToolSnapshot(): Readonly<AgentToolSnapshot> {
    return this.toolManager.getSnapshot()
  }

  addTools(
    tools: readonly ToolAdapter<any, any>[],
    options: { enabled?: boolean; mutable?: boolean; version?: number } = {},
  ): void {
    this.assertToolSetMutable()
    this.toolManager.addTools(tools, options)
    this.core.setTools(this.getActiveTools())
    this.emitStateChangedDetached('tools_changed')
  }

  configureMcpTools(client: McpClientManager): void {
    this.assertToolSetMutable()
    this.toolManager.configureMcpTools(client)
    this.core.setTools(this.getActiveTools())
    this.emitStateChangedDetached('tools_changed')
  }

  removeTools(names: readonly string[]): void {
    this.assertToolSetMutable()
    this.toolManager.removeTools(names)
    this.core.setTools(this.getActiveTools())
    this.emitStateChangedDetached('tools_changed')
  }

  hasTool(name: string): boolean {
    return this.toolManager.findTool(name) !== undefined
  }

  async setToolEnabled(name: string, enabled: boolean, expectedVersion: number): Promise<void> {
    await this.core.waitForIdle()
    const actualVersion = this.toolManager.getSnapshot().version
    if (expectedVersion !== actualVersion) {
      throw new AgentToolSnapshotConflictError(expectedVersion, actualVersion)
    }
    this.toolManager.requestToolChange(name, enabled)
    const changes = this.toolManager.commitPendingChanges()
    if (!changes.changed) return
    this.core.setTools(this.getActiveTools())
    this.emitStateChangedDetached('tools_changed')
  }

  private rebuildSystemPrompt(): void {
    const prompt = this.appendLoadedSkills(this.baseSystemPrompt)
    this.updateSystemPrompt(prompt)
    this.compactionManager.setSystemPrompt(prompt)
  }

  private getActiveTools(): ToolAdapter<any, any>[] {
    return this.toolManager.getTools()
  }

  private assertToolSetMutable(): void {
    if (this.isBusy()) {
      throw new Error('Cannot change the available tools while the agent is busy.')
    }
  }

  private refreshSkillCatalog(): void {
    if (!this.skillManager.refresh()) return
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.getSnapshot().model)
    this.rebuildSystemPrompt()
    this.emitStateChangedDetached('skills_changed')
  }

  private updateSystemPrompt(prompt: string): void {
    this.core.setMessages(this.runtime.applySystemPrompt(this.core.getMessages(), prompt))
  }

  updateProjectInstructions(instructions: ProjectInstructions): void {
    this.projectInstructions = instructions
    this.baseSystemPrompt = this.buildBaseSystemPrompt(this.core.getSnapshot().model)
    this.rebuildSystemPrompt()
    this.emitTokenAndState('system_prompt_changed')
  }

  getProjectInstructions(): ProjectInstructions | undefined {
    return this.projectInstructions
  }

  private buildBaseSystemPrompt(model: Model): string {
    const deferredToolNames = getDeferredToolNames()
    const prompt = getSystemPrompt({
      cwd: this.cwd,
      modelId: this.runtime.modelPromptIdentity(model),
      mcpServers: this.mcpServers,
      skills: [...this.skillManager.getSkills()],
      deferredToolNames: deferredToolNames.length > 0 ? deferredToolNames : undefined,
      projectInstructions: this.projectInstructions,
    }).join('\n\n')
    return prompt
  }

  private appendLoadedSkills(basePrompt: string): string {
    return this.skillManager.appendLoadedSkills(basePrompt)
  }

  private async commitCompaction(
    result: {
      summary: string
      messages: Message[]
      tokensBefore: number
      tokensAfter: number
      keptMessageCount: number
      automatic: boolean
    },
    persist: boolean,
  ): Promise<void> {
    try {
      if (persist && this.persistence) {
        this.compactionManager.reportProgress({
          phase: 'persisting',
          message: 'Persisting compacted session...',
          progress: 94,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        })
        await this.persistence.saveMessages(this.core.getMessages())
        const record: AgentCompactionRecord<Message> = {
          summary: result.summary,
          messages: result.messages,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          keptMessageCount: result.keptMessageCount,
          compactedMessageCount: result.messages.length,
          automatic: result.automatic,
          model: {
            provider: String(this.core.getSnapshot().model.provider),
            modelId: this.core.getSnapshot().model.id,
            contextWindow: this.core.getSnapshot().model.contextWindow,
          },
        }
        await this.persistence.recordCompaction(record)
      }
      this.compactionManager.reportProgress({
        phase: 'committing',
        message: 'Replacing active context...',
        progress: 98,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      })
      this.replaceMessages(result.messages, 'preserve')
      this.emitStateChangedDetached('compaction_completed')
      this.compactionManager.reportProgress({
        phase: 'done',
        message: `Compacted: ${result.tokensBefore} → ${result.tokensAfter} tokens`,
        progress: 100,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      })
    } catch (error) {
      this.compactionManager.reportProgress({
        phase: 'done',
        message:
          `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        progress: 100,
        tokensBefore: result.tokensBefore,
      })
      throw error
    }
  }

  private async handlePermissionRequest(
    kind: 'tool',
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ): Promise<boolean> {
    let preview: Record<string, unknown> | undefined
    try {
      preview = await this.toolManager.getApprovalPreview(toolName, input)
    } catch (error) {
      preview = {
        previewNotice: `Preview unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
    const request = this.createPermissionRequest(kind, toolName, input, description, preview)
    await this.emit({
      type: 'permission_requested',
      agentId: this.identity.id,
      request,
    })
    const allowed = this.permissionRequestHandler
      ? await this.permissionRequestHandler(toolName, input, description, request.requestId, preview)
      : false
    await this.emit({
      type: 'permission_resolved',
      agentId: this.identity.id,
      request,
      allowed,
    })
    return allowed
  }

  private async handleQuestionRequest(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ answers?: Record<string, string>; block?: boolean }> {
    const request = this.createPermissionRequest('question', toolName, input)
    await this.emit({
      type: 'permission_requested',
      agentId: this.identity.id,
      request,
    })
    const result = this.askUserQuestionHandler
      ? await this.askUserQuestionHandler(toolName, input, request.requestId)
      : { block: true }
    await this.emit({
      type: 'permission_resolved',
      agentId: this.identity.id,
      request,
      allowed: !result.block,
    })
    return result
  }

  private createPermissionRequest(
    kind: AgentPermissionRequest['kind'],
    toolName: string,
    input: Record<string, unknown>,
    description?: string,
    preview?: Record<string, unknown>,
  ): Readonly<AgentPermissionRequest> {
    return Object.freeze({
      requestId: globalThis.crypto.randomUUID(),
      kind,
      toolName,
      input: Object.freeze({ ...input }),
      description,
      ...(preview ? { preview: Object.freeze({ ...preview }) } : {}),
    })
  }

  private async emit(
    event: MicrocodeAgentEvent<Message>,
    signal: AbortSignal = this.eventController.signal,
  ): Promise<void> {
    for (const listener of [...this.listeners]) {
      await listener(event, signal)
    }
  }

  private emitDetached(event: MicrocodeAgentEvent<Message>): void {
    void this.emit(event).catch(() => {})
  }

  private async emitTokenUsage(signal?: AbortSignal): Promise<void> {
    await this.emit({
      type: 'token_usage',
      agentId: this.identity.id,
      usage: this.getTokenStats(),
    }, signal)
  }

  private async emitStateChanged(
    reason: AgentStateChangeReason,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.emit({
      type: 'state_changed',
      agentId: this.identity.id,
      reason,
      snapshot: this.getSnapshot(),
    }, signal)
  }

  private emitStateChangedDetached(
    reason: AgentStateChangeReason,
  ): void {
    this.emitDetached({
      type: 'state_changed',
      agentId: this.identity.id,
      reason,
      snapshot: this.getSnapshot(),
    })
  }

  private emitTokenAndState(reason: AgentStateChangeReason): void {
    this.emitDetached({
      type: 'token_usage',
      agentId: this.identity.id,
      usage: this.getTokenStats(),
    })
    this.emitStateChangedDetached(reason)
  }
}

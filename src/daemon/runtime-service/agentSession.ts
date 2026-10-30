import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import { AgentToolSnapshotConflictError, createMicrocodeAgentRuntime, type PiMicrocodeAgent, type MicrocodeAgentEvent } from '../../agent/index.ts'
import type { PiMicrocodeAgentOptions } from '../../agent/piRuntimeAdapter.ts'
import { PERMISSION_MODES, type PermissionMode } from '../../permissions/index.ts'
import type {
  JsonlSessionMetadata,
} from '@earendil-works/pi-agent-core/harness/session'
import { PiJsonlSessionStore, piSessionTranscriptAdapter } from '../../kernel/pi/session.ts'
import { SessionManager } from '../../session/SessionManager.ts'
import { GitRepository } from '../../git/GitRepository.ts'
import { toRuntimeMessage } from '../../kernel/pi/mapper.ts'
import { toRuntimeAgentEvent, toRuntimeAgentSnapshot } from '../../agent/runtimeProjection.ts'
import { isRuntimeThinkingLevel, type RuntimeImageInput } from '../../runtime/contracts.ts'
import type { McpServerState, ResolvedMcpServer } from '../../mcp/types.ts'
import type { McpClientManager } from '../../mcp/client.ts'
import { DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES, loadProjectInstructions, type ProjectInstructions } from '../../instructions/projectInstructions.ts'
import { buildInitTaskPrompt, extractInitDraft, getInitProjectFileOutline } from '../../instructions/initProjectGuidance.ts'
import { readMicroFile, writeMicroFile, type MicroFileSnapshot } from '../../instructions/writeMicroFile.ts'
import { PluginManager } from '../../plugins/PluginManager.ts'
import type { PluginSnapshot } from '../../plugins/types.ts'
import type { PluginRecord } from '../../plugins/types.ts'
import type { McpServerConfig } from '../../mcp/types.ts'
import { discoverMcpCapabilities, safeMcpConfigSummary } from '../../mcp/capabilities.ts'
import { exportSessionJsonl } from '../../kernel/pi/exportSession.ts'
import { buildPluginMentionContext } from '../../plugins/promptContext.ts'
import { getModelAuthProviders, getModelAuthStatus, getModelCatalog, loginModelProvider, logoutModelProvider } from '../../models/index.ts'
import type { ModelAuthPrompt, ModelAuthType } from '../../models/contracts.ts'
import { createRuntimeServiceServer, RuntimeServiceError } from './server.ts'
import type { RuntimeCommandEnvelope, RuntimeServiceServerHandle } from './types.ts'

interface PendingPermission {
  kind: 'tool' | 'question'
  promise: Promise<boolean | { answers?: Record<string, string>; block?: boolean }>
  resolve(value: boolean | { answers?: Record<string, string>; block?: boolean }): void
  timer: ReturnType<typeof setTimeout>
}

interface PendingModelAuthPrompt {
  resolve(value: string): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const PENDING_PERMISSION_TTL_MS = 5 * 60 * 1000
const PENDING_MODEL_AUTH_PROMPT_TTL_MS = 10 * 60 * 1000
type RuntimePluginSummary = Pick<PluginRecord, 'name' | 'version' | 'description' | 'health' | 'valid' | 'enabled' | 'scope' | 'skills' | 'servers' | 'diagnostics'>

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeServiceError('Command payload must be an object.')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new RuntimeServiceError(`${label} is required.`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some((item) => typeof item !== 'string' || !item || item.length > 4096)) {
    throw new RuntimeServiceError(`${label} must be an array of up to 1000 non-empty strings, each no longer than 4096 characters.`)
  }
  return value as string[]
}

function parseImages(value: unknown): RuntimeImageInput[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new RuntimeServiceError('images must be an array.')
  return value.map((image, index) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw new RuntimeServiceError(`images[${index}] must be an object.`)
    }
    const item = image as Record<string, unknown>
    if (item.type !== 'image' || typeof item.data !== 'string' || typeof item.mime_type !== 'string') {
      throw new RuntimeServiceError(`images[${index}] must contain type, data, and mime_type.`)
    }
    return { data: item.data, mimeType: item.mime_type }
  })
}

export interface RuntimeAgentSessionOptions {
  cwd?: string
  sessionManager?: RuntimeSessionManager
  sessionManagerOptions?: { sessionsRoot?: string; tasksRoot?: string }
  resumeSessionId?: string
  resumeLatest?: boolean
  onSessionIdChanged?: (sessionId: string) => void | Promise<void>
  agentOptions?: Omit<PiMicrocodeAgentOptions, 'cwd' | 'identity' | 'persistence' | 'permission'>
  permission?: PiMicrocodeAgentOptions['permission']
  mcpClient?: McpClientManager
  pluginManager?: PluginManager
  standaloneMcpConfigs?: Record<string, McpServerConfig>
  standaloneMcpServers?: readonly ResolvedMcpServer[]
  standaloneMcpDiagnostics?: readonly string[]
  plugins?: readonly RuntimePluginSummary[]
  capabilityDiagnostics?: readonly string[]
}

type RuntimeSessionManager = SessionManager<AgentMessage, JsonlSessionMetadata>

/** Owns one Microcode Agent and its durable session behind runtime DTOs. */
export class RuntimeAgentSession {
  private activeSessionId: string
  readonly agent: PiMicrocodeAgent
  private readonly cwd: string
  private readonly sessionManager: RuntimeSessionManager
  private readonly mcpClient?: McpClientManager
  private readonly pluginManager?: PluginManager
  private standaloneMcpDiagnostics: readonly string[]
  private standaloneMcpConfigs: Record<string, McpServerConfig>
  private standaloneMcpServers: readonly ResolvedMcpServer[]
  private plugins: RuntimePluginSummary[]
  private capabilityDiagnostics: readonly string[]
  private readonly onSessionIdChanged?: RuntimeAgentSessionOptions['onSessionIdChanged']
  private projectInstructions?: ProjectInstructions
  private readonly acceptedSessionIds = new Set<string>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly pendingModelAuthPrompts = new Map<string, PendingModelAuthPrompt>()
  private pendingInitSnapshot?: { revision: string; snapshot: MicroFileSnapshot }
  private modelAuthController?: AbortController
  private modelAuthTask?: Promise<void>
  private publisher?: (type: string, payload: Record<string, unknown>) => void
  private unsubscribeAgent?: () => void
  private activeTurn?: Promise<void>
  private pendingMcpRefresh = false
  private closed = false

  private constructor(options: {
    cwd: string
    sessionManager: RuntimeSessionManager
    sessionId: string
    agent: PiMicrocodeAgent
    mcpClient?: McpClientManager
    pluginManager?: PluginManager
    standaloneMcpConfigs?: Record<string, McpServerConfig>
    standaloneMcpServers?: readonly ResolvedMcpServer[]
    standaloneMcpDiagnostics?: readonly string[]
    plugins?: RuntimeAgentSessionOptions['plugins']
    capabilityDiagnostics?: RuntimeAgentSessionOptions['capabilityDiagnostics']
    onSessionIdChanged?: RuntimeAgentSessionOptions['onSessionIdChanged']
    projectInstructions?: ProjectInstructions
  }) {
    this.cwd = options.cwd
    this.sessionManager = options.sessionManager
    this.activeSessionId = options.sessionId
    this.acceptedSessionIds.add(options.sessionId)
    this.agent = options.agent
    this.mcpClient = options.mcpClient
    this.pluginManager = options.pluginManager
    this.standaloneMcpConfigs = { ...(options.standaloneMcpConfigs ?? {}) }
    this.standaloneMcpServers = [...(options.standaloneMcpServers ?? [])]
    this.standaloneMcpDiagnostics = [...(options.standaloneMcpDiagnostics ?? [])]
    this.plugins = [...(options.plugins ?? [])]
    this.capabilityDiagnostics = [...(options.capabilityDiagnostics ?? [])]
    this.onSessionIdChanged = options.onSessionIdChanged
    this.projectInstructions = options.projectInstructions
    this.unsubscribeAgent = this.agent.subscribe((event) => this.onAgentEvent(event))
  }

  get sessionId(): string {
    return this.activeSessionId
  }

  static async create(options: RuntimeAgentSessionOptions = {}): Promise<RuntimeAgentSession> {
    const cwd = options.cwd ?? process.cwd()
    const sessionManager = options.sessionManager ?? new SessionManager({
      store: new PiJsonlSessionStore(options.sessionManagerOptions?.sessionsRoot),
      transcript: piSessionTranscriptAdapter,
      tasksRoot: options.sessionManagerOptions?.tasksRoot,
    })
    try {
      let restoredMessages: AgentMessage[] | undefined
      if (options.resumeSessionId || options.resumeLatest) {
        const sessions = await sessionManager.list(cwd)
        const matches = options.resumeSessionId
          ? sessions.filter((session) => session.id.startsWith(options.resumeSessionId!))
          : sessions
        if (matches.length > 1) throw new RuntimeServiceError('The requested session ID is ambiguous.', 409, 'session_id_ambiguous')
        const meta = matches[0]
        if (meta) restoredMessages = await sessionManager.open(meta)
        else if (options.resumeSessionId) throw new RuntimeServiceError('The requested session was not found.', 404, 'session_not_found')
        else {
          sessionManager.beginDraft(cwd)
          await sessionManager.ensureCreated(cwd)
        }
      } else {
        sessionManager.beginDraft(cwd)
        await sessionManager.ensureCreated(cwd)
      }
      const sessionId = sessionManager.getSessionId()
      if (!sessionId) throw new Error('Session manager failed to initialize a session.')

      let runtime: RuntimeAgentSession | undefined
      const agent = createMicrocodeAgentRuntime({
        ...options.agentOptions,
        cwd,
        pluginPromptContext: (input, scanText) => buildPluginMentionContext(
          options.agentOptions?.pluginPromptContext?.(input, scanText) ?? input,
          options.pluginManager?.getPlugins() ?? [],
          scanText,
        ),
        persistence: sessionManager,
        identity: { id: `assistant-${sessionId}`, name: 'Microcode', role: 'assistant' },
        permission: {
          ...options.permission,
          onPermissionRequest: (_toolName, _input, _description, requestId) =>
            runtime?.waitForPermission(requestId) ?? Promise.resolve(false),
          onAskUserQuestion: (_toolName, _input, requestId) =>
            runtime?.waitForQuestion(requestId) ?? Promise.resolve({ block: true }),
        },
      })
      if (options.mcpClient) agent.configureMcpTools(options.mcpClient)
      runtime = new RuntimeAgentSession({
        cwd,
        sessionManager,
        sessionId,
        agent,
        mcpClient: options.mcpClient,
        pluginManager: options.pluginManager,
        standaloneMcpConfigs: options.standaloneMcpConfigs,
        standaloneMcpServers: options.standaloneMcpServers,
        standaloneMcpDiagnostics: options.standaloneMcpDiagnostics,
        plugins: options.plugins,
        capabilityDiagnostics: options.capabilityDiagnostics,
        onSessionIdChanged: options.onSessionIdChanged,
        projectInstructions: options.agentOptions?.projectInstructions,
      })
      if (restoredMessages?.length) agent.replaceMessages(restoredMessages, 'rebuild')
      return runtime
    } catch (error) {
      await sessionManager.close().catch(() => undefined)
      throw error
    }
  }

  getSnapshot(): unknown {
    return toRuntimeAgentSnapshot(this.agent.getSnapshot(), this.agent.getMessages().map(toRuntimeMessage), {
      mcpServers: this.getRuntimeMcpServers(),
      plugins: this.plugins,
      capabilityDiagnostics: this.capabilityDiagnostics,
      projectInstructions: this.projectInstructions,
      session: {
        id: this.activeSessionId,
        cwd: this.cwd,
        createdAt: this.sessionManager.getMetadata()?.createdAt ?? Date.now(),
        ...(this.sessionManager.getTitle(this.activeSessionId) ? { title: this.sessionManager.getTitle(this.activeSessionId) } : {}),
      },
    })
  }

  private getRuntimeMcpServers() {
    return (this.mcpClient?.getServerStates() ?? []).map((server) => ({
      name: server.name,
      status: server.status,
      toolCount: server.tools.length,
      resourceCount: server.resources.length,
      summary: safeMcpConfigSummary(server.config),
    }))
  }

  attachPublisher(publisher: (type: string, payload: Record<string, unknown>) => void): void {
    this.publisher = publisher
  }

  updateMcpServers(): void {
    if (this.closed) return
    if (this.activeTurn || this.agent.isBusy()) {
      this.pendingMcpRefresh = true
      return
    }
    this.applyMcpRefresh()
  }

  private applyPendingMcpRefresh(): void {
    if (this.closed || !this.pendingMcpRefresh || this.activeTurn || this.agent.isBusy()) return
    this.pendingMcpRefresh = false
    this.applyMcpRefresh()
  }

  private applyMcpRefresh(): void {
    const servers = this.mcpClient?.getServerStates() ?? []
    this.agent.updateMcpServers(servers)
    if (this.mcpClient) this.agent.configureMcpTools(this.mcpClient)
    this.publisher?.('capabilities_changed', { mcp_server_count: servers.length })
  }

  private async refreshPlugins(snapshot: PluginSnapshot): Promise<void> {
    this.plugins = [...snapshot.plugins]
    const diagnostics = [
      ...this.standaloneMcpDiagnostics,
      ...snapshot.diagnostics,
      ...snapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`)),
    ]
    this.agent.setPluginSkills([...snapshot.skills], [
      ...snapshot.diagnostics,
      ...snapshot.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`)),
    ])
    await this.reconcileMcpServers(snapshot, diagnostics)
  }

  private async refreshMcp(): Promise<void> {
    const discovered = await discoverMcpCapabilities(this.cwd)
    this.standaloneMcpConfigs = { ...discovered.configs }
    this.standaloneMcpServers = [...discovered.servers]
    this.standaloneMcpDiagnostics = [...discovered.diagnostics]
    const snapshot = this.pluginManager?.getSnapshot()
    const diagnostics = [
      ...discovered.diagnostics,
      ...(snapshot?.diagnostics ?? []),
      ...(snapshot?.plugins.flatMap((plugin) => plugin.diagnostics.map((diagnostic) => `${plugin.name}: ${diagnostic}`)) ?? []),
    ]
    await this.reconcileMcpServers(snapshot, diagnostics)
  }

  private async reconcileMcpServers(
    snapshot?: PluginSnapshot,
    initialDiagnostics: string[] = [...this.standaloneMcpDiagnostics],
  ): Promise<void> {
    const desired = { ...this.standaloneMcpConfigs }
    for (const [name, config] of Object.entries(snapshot?.mcpServers ?? {})) {
      if (Object.hasOwn(desired, name)) {
        initialDiagnostics.push(`Plugin MCP server "${name}" conflicts with a configured MCP server; plugin server skipped.`)
        continue
      }
      desired[name] = config
    }
    this.capabilityDiagnostics = initialDiagnostics
    if (!this.mcpClient) {
      this.publisher?.('capabilities_changed', { mcp_server_count: 0 })
      return
    }

    const currentStates = this.mcpClient.getServerStates()
    for (const state of currentStates) {
      if (!Object.hasOwn(desired, state.name)) await this.mcpClient.removeServer(state.name)
    }
    const connections: Promise<void>[] = []
    for (const [name, config] of Object.entries(desired)) {
      const current = this.mcpClient.getServer(name)
      if (current && JSON.stringify(current.config) === JSON.stringify(config)
        && current.status !== 'disconnected' && current.status !== 'disabled') continue
      connections.push(this.mcpClient.connectServer(name, config))
    }
    this.updateMcpServers()
    void Promise.allSettled(connections).then(() => this.updateMcpServers())
  }

  acceptsSession(sessionId: string): boolean {
    return sessionId === this.activeSessionId
  }

  async dispatch(
    command: RuntimeCommandEnvelope,
    publish: (type: string, payload: Record<string, unknown>) => void,
  ): Promise<unknown> {
    if (this.closed) throw new RuntimeServiceError('Runtime session is closed.', 409, 'session_closed')
    if (!this.acceptsSession(command.session_id)) throw new RuntimeServiceError('Runtime session was not found.', 404, 'session_not_found')
    this.publisher = publish
    const payload = objectPayload(command.command.payload)

    switch (command.command.type) {
      case 'prompt':
      case 'prompt.read_only': {
        this.assertAgentIdle()
        const text = requiredString(payload.text, 'text')
        const images = parseImages(payload.images)
        const turn = command.command.type === 'prompt.read_only'
          ? this.agent.promptReadOnly(text)
          : this.agent.prompt(text, images)
        // Return the command acknowledgement immediately so permission replies and aborts
        // can reach the runtime while the model turn is still in flight.
        const trackedTurn = turn.then(async () => {
          await this.agent.persistMessages()
        }).catch(() => {
          publish('runtime_error', { code: 'agent_turn_failed', message: 'The Agent turn failed.' })
        }).finally(() => {
          if (this.activeTurn === trackedTurn) {
            this.activeTurn = undefined
            this.applyPendingMcpRefresh()
          }
        })
        this.activeTurn = trackedTurn
        return { accepted: true }
      }
      case 'abort':
        this.agent.abort()
        return { accepted: true }
      case 'model.catalog':
        return getModelCatalog()
      case 'model.auth.providers':
        return getModelAuthProviders()
      case 'model.auth.status':
        return getModelAuthStatus()
      case 'model.auth.login': {
        const providerId = requiredString(payload.provider_id, 'provider_id')
        if (payload.auth_type !== 'oauth' && payload.auth_type !== 'api_key') {
          throw new RuntimeServiceError('auth_type must be oauth or api_key.')
        }
        if (this.modelAuthTask) throw new RuntimeServiceError('A provider sign-in flow is already active.', 409, 'auth_busy')
        const controller = new AbortController()
        this.modelAuthController = controller
        const task = this.runModelAuthLogin(providerId, payload.auth_type as ModelAuthType, controller, publish)
        this.modelAuthTask = task
        return { accepted: true }
      }
      case 'model.auth.prompt.resolve': {
        const requestId = requiredString(payload.request_id, 'request_id')
        const pending = this.pendingModelAuthPrompts.get(requestId)
        if (!pending) throw new RuntimeServiceError('Auth prompt is not pending.', 404, 'pending_request_not_found')
        if (payload.cancel !== true && (typeof payload.value !== 'string' || payload.value.length > 16_384)) {
          throw new RuntimeServiceError('Auth prompt response must be a string no longer than 16384 characters.')
        }
        clearTimeout(pending.timer)
        this.pendingModelAuthPrompts.delete(requestId)
        if (payload.cancel === true) pending.reject(new Error('Authentication cancelled.'))
        else pending.resolve(payload.value as string)
        return { resolved: true }
      }
      case 'model.auth.cancel':
        this.modelAuthController?.abort(new Error('Authentication cancelled.'))
        return { cancelled: Boolean(this.modelAuthController) }
      case 'model.auth.logout': {
        const providerId = requiredString(payload.provider_id, 'provider_id')
        try {
          await logoutModelProvider(providerId)
          return { logged_out: true }
        } catch {
          throw new RuntimeServiceError('Provider sign-out failed.', 400, 'auth_logout_failed')
        }
      }
      case 'model.select': {
        this.assertAgentIdle()
        const modelId = requiredString(payload.model_id, 'model_id')
        const api = typeof payload.api_id === 'string' ? payload.api_id as Parameters<PiMicrocodeAgent['switchModel']>[1] : undefined
        const provider = typeof payload.provider_id === 'string' ? payload.provider_id : undefined
        const snapshot = this.agent.switchModel(modelId, api, provider)
        return { model_id: snapshot.model.model_id, provider_id: snapshot.provider }
      }
      case 'session.title.suggest': {
        const openingSentence = requiredString(payload.opening_sentence, 'opening_sentence')
        if (openingSentence.length > 500) throw new RuntimeServiceError('opening_sentence must be at most 500 characters.')
        return { title: await this.agent.suggestSessionTitle(openingSentence) }
      }
      case 'thinking.set': {
        if (!isRuntimeThinkingLevel(payload.level)) {
          throw new RuntimeServiceError('level must be a supported thinking level.')
        }
        this.assertAgentIdle()
        this.agent.setThinkingLevel(payload.level)
        return { level: payload.level }
      }
      case 'permission.set': {
        if (typeof payload.mode !== 'string' || !PERMISSION_MODES.includes(payload.mode as PermissionMode)) {
          throw new RuntimeServiceError('mode must be a supported permission mode.')
        }
        this.agent.setPermissionMode(payload.mode as PermissionMode)
        return { mode: payload.mode }
      }
      case 'permission.check': {
        const toolId = requiredString(payload.tool_id, 'tool_id')
        const input = objectPayload(payload.input)
        return this.agent.checkPermission(toolId, input)
      }
      case 'permission.request': {
        const toolId = requiredString(payload.tool_id, 'tool_id')
        const input = objectPayload(payload.input)
        const description = typeof payload.description === 'string' ? payload.description : ''
        void this.agent.requestToolPermission(toolId, input, description).catch(() => undefined)
        return { accepted: true }
      }
      case 'permission.rule.add': {
        const toolId = requiredString(payload.tool_id, 'tool_id')
        const ruleContent = typeof payload.rule_content === 'string' ? payload.rule_content : undefined
        this.agent.addSessionPermission(toolId, ruleContent)
        return { added: true }
      }
      case 'permission.resolve':
        this.resolvePermission(requiredString(payload.request_id, 'request_id'), payload.allowed)
        return { resolved: true }
      case 'question.resolve':
        this.resolveQuestion(requiredString(payload.request_id, 'request_id'), payload.answers, payload.block)
        return { resolved: true }
      case 'tool.set': {
        const toolId = requiredString(payload.tool_id, 'tool_id')
        if (typeof payload.enabled !== 'boolean') throw new RuntimeServiceError('enabled must be a boolean.')
        this.assertAgentIdle()
        if (!Number.isSafeInteger(payload.expected_version) || (payload.expected_version as number) < 1) {
          throw new RuntimeServiceError('expected_version must be the positive integer version from the current tool snapshot.')
        }
        try {
          await this.agent.setToolEnabled(toolId, payload.enabled, payload.expected_version as number)
        } catch (error) {
          if (error instanceof AgentToolSnapshotConflictError) {
            throw new RuntimeServiceError(error.message, 409, 'stale_tool_snapshot')
          }
          throw error
        }
        return { version: this.agent.getToolSnapshot().version }
      }
      case 'session.clear': {
        this.assertAgentIdle()
        await this.sessionManager.create(this.cwd)
        const nextSessionId = this.sessionManager.getSessionId()
        if (!nextSessionId) throw new Error('Session manager failed to create a replacement session.')
        this.acceptedSessionIds.add(nextSessionId)
        this.activeSessionId = nextSessionId
        await this.onSessionIdChanged?.(nextSessionId)
        this.agent.clearMessages()
        return { session_id: nextSessionId }
      }
      case 'session.list': {
        const sessions = await this.sessionManager.listWithTitles(this.cwd)
        return sessions.map(({ id, cwd, createdAt, title }) => ({ id, cwd, created_at: createdAt, title }))
      }
      case 'session.open': {
        this.assertAgentIdle()
        const requestedId = requiredString(payload.session_id, 'session_id')
        const sessions = await this.sessionManager.list(this.cwd)
        const matches = sessions.filter((session) => session.id.startsWith(requestedId))
        if (matches.length > 1) throw new RuntimeServiceError('The requested session ID is ambiguous.', 409, 'session_id_ambiguous')
        const meta = matches[0]
        if (!meta) throw new RuntimeServiceError('The requested session was not found.', 404, 'session_not_found')
        await this.agent.persistMessages()
        const messages = await this.sessionManager.switchToSession(meta)
        this.activeSessionId = meta.id
        this.acceptedSessionIds.add(meta.id)
        await this.onSessionIdChanged?.(meta.id)
        this.agent.replaceMessages(messages, 'rebuild')
        return { session_id: meta.id }
      }
      case 'session.title.set': {
        const sessionId = requiredString(payload.session_id, 'session_id')
        const title = requiredString(payload.title, 'title').trim()
        if (!this.acceptedSessionIds.has(sessionId) || sessionId !== this.activeSessionId) {
          throw new RuntimeServiceError('Titles can only be updated for the active session.', 409, 'inactive_session')
        }
        if (title.length > 160) throw new RuntimeServiceError('Session title is too long.')
        this.sessionManager.setTitle(sessionId, title)
        return { session_id: sessionId, title }
      }
      case 'session.tasks.list':
        return await this.sessionManager.listTaskLists()
      case 'session.tasks.remind': {
        const listId = requiredString(payload.list_id, 'list_id')
        const taskId = requiredString(payload.task_id, 'task_id')
        if (typeof payload.reminder !== 'boolean') throw new RuntimeServiceError('reminder must be a boolean.')
        return await this.sessionManager.remindTask(listId, taskId, payload.reminder)
      }
      case 'session.export': {
        const metadata = this.sessionManager.getMetadata()
        if (!metadata) throw new RuntimeServiceError('There is no saved conversation to export yet.', 404, 'session_not_found')
        await this.agent.persistMessages()
        return { path: await exportSessionJsonl(metadata.path, this.cwd, metadata.id) }
      }
      case 'session.compact': {
        this.assertAgentIdle()
        const instructions = typeof payload.instructions === 'string' ? payload.instructions : undefined
        const result = await this.agent.compact({ instructions, persistToSession: true })
        // Compaction updates the runtime-owned transcript. The client needs only
        // progress metadata; sending the full Pi message array would cross the
        // process boundary and can expose private prompt/reasoning content.
        return {
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          keptMessageCount: result.keptMessageCount,
          automatic: result.automatic,
        }
      }
      case 'skill.set': {
        const skillId = requiredString(payload.skill_id, 'skill_id')
        if (typeof payload.enabled !== 'boolean') throw new RuntimeServiceError('enabled must be a boolean.')
        this.assertAgentIdle()
        if (payload.enabled) this.agent.loadSkill(skillId)
        else this.agent.unloadSkill(skillId)
        this.agent.refreshSystemPrompt()
        return { loaded: this.agent.getLoadedSkillNames().includes(skillId) }
      }
      case 'plugin.refresh': {
        this.assertAgentIdle()
        if (!this.pluginManager) throw new RuntimeServiceError('Plugin management is unavailable.', 503, 'plugin_manager_unavailable')
        const snapshot = await this.pluginManager.refresh()
        await this.refreshPlugins(snapshot)
        return { plugin_count: snapshot.plugins.length }
      }
      case 'plugin.set': {
        this.assertAgentIdle()
        if (!this.pluginManager) throw new RuntimeServiceError('Plugin management is unavailable.', 503, 'plugin_manager_unavailable')
        const pluginName = requiredString(payload.plugin_name, 'plugin_name')
        if (typeof payload.enabled !== 'boolean') throw new RuntimeServiceError('enabled must be a boolean.')
        const snapshot = await this.pluginManager.setEnabled(pluginName, payload.enabled)
        await this.refreshPlugins(snapshot)
        return { plugin_name: pluginName, enabled: payload.enabled }
      }
      case 'plugin.set_many': {
        this.assertAgentIdle()
        if (!this.pluginManager) throw new RuntimeServiceError('Plugin management is unavailable.', 503, 'plugin_manager_unavailable')
        if (payload.scope !== 'user' && payload.scope !== 'project') throw new RuntimeServiceError('scope must be user or project.')
        const states = objectPayload(payload.states)
        const desiredStates = new Map<string, boolean>()
        for (const [name, enabled] of Object.entries(states)) {
          if (typeof enabled !== 'boolean') throw new RuntimeServiceError(`Plugin state for "${name}" must be a boolean.`)
          desiredStates.set(name, enabled)
        }
        const snapshot = await this.pluginManager.setEnabledMany(payload.scope, desiredStates)
        await this.refreshPlugins(snapshot)
        return { plugin_count: snapshot.plugins.length }
      }
      case 'mcp.refresh': {
        this.assertAgentIdle()
        await this.refreshMcp()
        return {
          server_count: this.mcpClient?.getServerStates().length ?? 0,
          configured_servers: this.standaloneMcpServers.map((server) => ({
            name: server.name,
            scope: server.scope,
            ...(server.packageName ? { package_name: server.packageName } : {}),
            ...(server.sourcePath ? { source_path: server.sourcePath } : {}),
            summary: safeMcpConfigSummary(server.config),
          })),
        }
      }
      case 'git.status':
        return GitRepository.open(this.cwd).then((repository) => repository.status())
      case 'git.branches':
        return GitRepository.open(this.cwd).then((repository) => repository.branches())
      case 'git.diff': {
        if (payload.staged !== undefined && typeof payload.staged !== 'boolean') throw new RuntimeServiceError('staged must be a boolean.')
        const paths = payload.paths === undefined ? [] : stringArray(payload.paths, 'paths')
        return GitRepository.open(this.cwd).then((repository) => repository.diff(payload.staged === true, paths))
      }
      case 'git.history': {
        const limit = payload.limit === undefined ? 20 : payload.limit
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new RuntimeServiceError('limit must be an integer between 1 and 100.')
        }
        return GitRepository.open(this.cwd).then((repository) => repository.history(limit))
      }
      case 'git.stage': {
        this.assertAgentIdle()
        const paths = stringArray(payload.paths, 'paths')
        await (await GitRepository.open(this.cwd)).stage(paths)
        return { staged_paths: paths.length }
      }
      case 'git.unstage': {
        this.assertAgentIdle()
        const paths = stringArray(payload.paths, 'paths')
        await (await GitRepository.open(this.cwd)).unstage(paths)
        return { unstaged_paths: paths.length }
      }
      case 'git.discard': {
        this.assertAgentIdle()
        const paths = stringArray(payload.paths, 'paths')
        await (await GitRepository.open(this.cwd)).discard(paths)
        return { discarded_paths: paths.length }
      }
      case 'git.commit': {
        this.assertAgentIdle()
        const message = requiredString(payload.message, 'message')
        const commit = await (await GitRepository.open(this.cwd)).commit(message)
        return { commit }
      }
      case 'git.branch.switch': {
        this.assertAgentIdle()
        const name = requiredString(payload.name, 'name')
        await (await GitRepository.open(this.cwd)).switchBranch(name)
        return { branch: name }
      }
      case 'git.branch.create': {
        this.assertAgentIdle()
        const name = requiredString(payload.name, 'name')
        await (await GitRepository.open(this.cwd)).createBranch(name)
        return { branch: name }
      }
      case 'git.branch.delete': {
        this.assertAgentIdle()
        const name = requiredString(payload.name, 'name')
        await (await GitRepository.open(this.cwd)).deleteBranch(name)
        return { branch: name }
      }
      case 'git.fetch': {
        this.assertAgentIdle()
        await (await GitRepository.open(this.cwd)).fetch()
        return { fetched: true }
      }
      case 'git.pull': {
        this.assertAgentIdle()
        await (await GitRepository.open(this.cwd)).pull()
        return { pulled: true }
      }
      case 'git.push': {
        this.assertAgentIdle()
        await (await GitRepository.open(this.cwd)).push()
        return { pushed: true }
      }
      case 'git.stash.push': {
        this.assertAgentIdle()
        if (payload.message !== undefined && typeof payload.message !== 'string') throw new RuntimeServiceError('message must be a string.')
        await (await GitRepository.open(this.cwd)).stashPush(payload.message as string | undefined)
        return { stashed: true }
      }
      case 'git.stash.list':
        return GitRepository.open(this.cwd).then((repository) => repository.stashList())
      case 'git.stash.apply': {
        this.assertAgentIdle()
        const ref = requiredString(payload.ref, 'ref')
        if (payload.pop !== undefined && typeof payload.pop !== 'boolean') throw new RuntimeServiceError('pop must be a boolean.')
        await (await GitRepository.open(this.cwd)).stashApply(ref, payload.pop === true)
        return { applied: true, popped: payload.pop === true }
      }
      case 'instructions.init.propose': {
        this.assertAgentIdle()
        const before = await readMicroFile(this.cwd)
        const outline = await getInitProjectFileOutline(this.cwd)
        const messageCount = this.agent.getMessages().length
        try {
          await this.agent.promptReadOnly(buildInitTaskPrompt(this.cwd, outline))
        } catch {
          throw new RuntimeServiceError('Project initialization proposal failed.', 400, 'init_proposal_failed')
        }
        const latestAssistant = this.agent.getMessages().slice(messageCount).reverse()
          .find((message) => message.role === 'assistant')
        const response = latestAssistant?.content
          .map((block) => block.type === 'text' ? block.text : '')
          .filter(Boolean)
          .join('\n') ?? ''
        const proposal = extractInitDraft(response)
        const revision = randomUUID()
        this.pendingInitSnapshot = proposal === undefined ? undefined : { revision, snapshot: before }
        return {
          revision,
          path: before.path,
          current_content: before.content ?? '',
          ...(proposal === undefined ? {} : { proposal }),
          max_bytes: DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES,
        }
      }
      case 'instructions.init.apply': {
        this.assertAgentIdle()
        const revision = requiredString(payload.revision, 'revision')
        if (typeof payload.proposal !== 'string') throw new RuntimeServiceError('proposal must be a string.')
        const pending = this.pendingInitSnapshot
        if (!pending || pending.revision !== revision) {
          throw new RuntimeServiceError('The MICRO.md proposal expired. Run /init again.', 409, 'init_proposal_expired')
        }
        this.pendingInitSnapshot = undefined
        const proposal = payload.proposal
        const proposalBytes = Buffer.byteLength(proposal, 'utf8')
        if (proposalBytes > DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES) {
          throw new RuntimeServiceError(`The MICRO.md proposal exceeds the ${DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES}-byte project instruction limit.`)
        }
        const currentInstructions = await loadProjectInstructions(this.cwd)
        const otherInstructionBytes = currentInstructions.files
          .filter((file) => file.path !== pending.snapshot.path)
          .reduce((total, file) => total + file.bytes, 0)
        if (otherInstructionBytes + proposalBytes > DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES) {
          throw new RuntimeServiceError('The proposal does not fit in the remaining project instruction budget. Shorten existing instruction files or ask for a shorter proposal.')
        }
        await writeMicroFile(this.cwd, pending.snapshot, proposal)
        const instructions = await loadProjectInstructions(this.cwd)
        this.projectInstructions = instructions
        this.agent.updateProjectInstructions(instructions)
        const loadedFile = instructions.files.find((file) => file.path === pending.snapshot.path)
        if (!loadedFile || loadedFile.truncated || loadedFile.content !== proposal) {
          throw new RuntimeServiceError(`MICRO.md was saved, but the complete file could not be loaded within the ${DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES}-byte combined instruction limit.`)
        }
        return { path: pending.snapshot.path, file_count: instructions.files.length, total_bytes: instructions.totalBytes }
      }
      case 'instructions.reload': {
        this.assertAgentIdle()
        this.projectInstructions = await loadProjectInstructions(this.cwd)
        this.agent.updateProjectInstructions(this.projectInstructions)
        return { file_count: this.projectInstructions.files.length }
      }
      default:
        throw new RuntimeServiceError('Command type is not supported by this runtime session.', 400, 'unknown_command')
    }
  }

  async waitForIdle(): Promise<void> {
    await this.activeTurn
    await this.agent.waitForIdle()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.modelAuthController?.abort(new Error('Runtime session is closing.'))
    await this.modelAuthTask?.catch(() => undefined)
    if (this.agent.isBusy()) this.agent.abort()
    for (const pending of this.pendingPermissions.values()) {
      clearTimeout(pending.timer)
      if (pending.kind === 'question') pending.resolve({ block: true })
      else pending.resolve(false)
    }
    this.pendingPermissions.clear()
    await this.waitForIdle().catch(() => undefined)
    await this.agent.persistMessages().catch(() => undefined)
    this.unsubscribeAgent?.()
    this.unsubscribeAgent = undefined
    await this.sessionManager.close()
  }

  private onAgentEvent(event: MicrocodeAgentEvent<AgentMessage>): void {
    if (event.type === 'permission_requested') this.ensurePendingPermission(event.request.requestId, event.request.kind)
    if (event.type === 'permission_resolved') this.pendingPermissions.delete(event.request.requestId)
    const mapped = toRuntimeAgentEvent(event, toRuntimeMessage)
    if (event.type === 'state_changed') {
      mapped.payload.snapshot = toRuntimeAgentSnapshot(event.snapshot, [], {
        mcpServers: this.getRuntimeMcpServers(),
        plugins: this.plugins,
        capabilityDiagnostics: this.capabilityDiagnostics,
        projectInstructions: this.projectInstructions,
        session: {
          id: this.activeSessionId,
          cwd: this.cwd,
          createdAt: this.sessionManager.getMetadata()?.createdAt ?? Date.now(),
          ...(this.sessionManager.getTitle(this.activeSessionId) ? { title: this.sessionManager.getTitle(this.activeSessionId) } : {}),
        },
      })
    }
    this.publisher?.(mapped.type, mapped.payload)
  }

  private waitForPermission(requestId: string): Promise<boolean> {
    return this.ensurePendingPermission(requestId, 'tool').promise as Promise<boolean>
  }

  private waitForQuestion(requestId: string): Promise<{ answers?: Record<string, string>; block?: boolean }> {
    return this.ensurePendingPermission(requestId, 'question').promise as Promise<{ answers?: Record<string, string>; block?: boolean }>
  }

  private ensurePendingPermission(requestId: string, kind: 'tool' | 'question'): PendingPermission {
    const existing = this.pendingPermissions.get(requestId)
    if (existing) return existing
    let resolve!: PendingPermission['resolve']
    const promise = new Promise<boolean | { answers?: Record<string, string>; block?: boolean }>((resolvePromise) => {
      resolve = resolvePromise
    })
    const pending = { kind, promise, resolve, timer: undefined as unknown as ReturnType<typeof setTimeout> }
    pending.timer = setTimeout(() => {
      if (this.pendingPermissions.get(requestId) !== pending) return
      this.pendingPermissions.delete(requestId)
      pending.resolve(kind === 'question' ? { block: true } : false)
      this.publisher?.('permission_expired', { request_id: requestId, kind })
    }, PENDING_PERMISSION_TTL_MS)
    this.pendingPermissions.set(requestId, pending)
    return pending
  }

  private resolvePermission(requestId: string, allowed: unknown): void {
    if (typeof allowed !== 'boolean') throw new RuntimeServiceError('allowed must be a boolean.')
    const pending = this.pendingPermissions.get(requestId)
    if (!pending || pending.kind !== 'tool') throw new RuntimeServiceError('Permission request is not pending.', 404, 'pending_request_not_found')
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(requestId)
    pending.resolve(allowed)
  }

  private resolveQuestion(requestId: string, answers: unknown, block: unknown): void {
    if (answers !== undefined && (!answers || typeof answers !== 'object' || Array.isArray(answers))) {
      throw new RuntimeServiceError('answers must be a JSON object.')
    }
    if (answers && Object.values(answers as Record<string, unknown>).some((answer) => typeof answer !== 'string')) {
      throw new RuntimeServiceError('Every answer must be a string.')
    }
    if (block !== undefined && typeof block !== 'boolean') throw new RuntimeServiceError('block must be a boolean.')
    const pending = this.pendingPermissions.get(requestId)
    if (!pending || pending.kind !== 'question') throw new RuntimeServiceError('Question request is not pending.', 404, 'pending_request_not_found')
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(requestId)
    pending.resolve({ answers: answers as Record<string, string> | undefined, block: block as boolean | undefined })
  }

  private requestModelAuthPrompt(prompt: ModelAuthPrompt, authSignal: AbortSignal, publish: (type: string, payload: Record<string, unknown>) => void): Promise<string> {
    const requestId = crypto.randomUUID()
    return new Promise<string>((resolve, reject) => {
      const { signal: _promptSignal, ...safePrompt } = prompt
      const pending: PendingModelAuthPrompt = {
        resolve: (value) => { clearTimeout(pending.timer); this.pendingModelAuthPrompts.delete(requestId); resolve(value) },
        reject: (error) => { clearTimeout(pending.timer); this.pendingModelAuthPrompts.delete(requestId); reject(error) },
        timer: setTimeout(() => {
          if (this.pendingModelAuthPrompts.get(requestId) !== pending) return
          pending.reject(new Error('Authentication prompt expired.'))
          publish('model_auth_prompt_cancelled', { request_id: requestId })
        }, PENDING_MODEL_AUTH_PROMPT_TTL_MS),
      }
      if (authSignal.aborted || prompt.signal?.aborted) {
        clearTimeout(pending.timer)
        reject(new Error('Authentication cancelled.'))
        return
      }
      this.pendingModelAuthPrompts.set(requestId, pending)
      publish('model_auth_prompt', { request_id: requestId, prompt: safePrompt })
      const abortPrompt = () => {
        if (this.pendingModelAuthPrompts.get(requestId) !== pending) return
        pending.reject(new Error('Authentication cancelled.'))
        publish('model_auth_prompt_cancelled', { request_id: requestId })
      }
      authSignal.addEventListener('abort', abortPrompt, { once: true })
      prompt.signal?.addEventListener('abort', abortPrompt, { once: true })
      const originalResolve = pending.resolve
      const originalReject = pending.reject
      pending.resolve = (value) => {
        authSignal.removeEventListener('abort', abortPrompt)
        prompt.signal?.removeEventListener('abort', abortPrompt)
        originalResolve(value)
      }
      pending.reject = (error) => {
        authSignal.removeEventListener('abort', abortPrompt)
        prompt.signal?.removeEventListener('abort', abortPrompt)
        originalReject(error)
      }
    })
  }

  private async runModelAuthLogin(
    providerId: string,
    authType: ModelAuthType,
    controller: AbortController,
    publish: (type: string, payload: Record<string, unknown>) => void,
  ): Promise<void> {
    try {
      await loginModelProvider(providerId, authType, {
        signal: controller.signal,
        prompt: (prompt) => this.requestModelAuthPrompt(prompt, controller.signal, publish),
        notify: (event) => publish('model_auth_notification', { event }),
      })
      publish('model_auth_complete', { success: true })
    } catch {
      publish('model_auth_complete', {
        success: false,
        message: controller.signal.aborted ? 'Provider sign-in was cancelled.' : 'Provider sign-in failed or was cancelled.',
      })
    } finally {
      for (const [requestId, pending] of this.pendingModelAuthPrompts) {
        pending.reject(new Error('Authentication flow ended.'))
        this.pendingModelAuthPrompts.delete(requestId)
      }
      if (this.modelAuthTask) this.modelAuthTask = undefined
      if (this.modelAuthController === controller) this.modelAuthController = undefined
    }
  }

  private assertAgentIdle(): void {
    if (this.activeTurn || this.agent.isBusy()) {
      throw new RuntimeServiceError('Wait for the current Agent turn to finish before changing runtime state.', 409, 'agent_busy')
    }
  }
}

export async function createRuntimeAgentService(options: {
  token: string
  hostname?: string
  port?: number
  session?: RuntimeAgentSessionOptions
  onShutdown?: () => void | Promise<void>
}): Promise<{ session: RuntimeAgentSession; server: RuntimeServiceServerHandle; close(): Promise<void> }> {
  const session = await RuntimeAgentSession.create(options.session)
  let server: RuntimeServiceServerHandle
  let closing: Promise<void> | undefined
  const close = async () => {
    if (closing) return closing
    closing = (async () => {
      await server.stop()
      await session.close()
      await options.onShutdown?.()
    })()
    return closing
  }
  try {
    server = createRuntimeServiceServer({
      token: options.token,
      hostname: options.hostname,
      port: options.port,
      getSnapshot: (sessionId) => session.acceptsSession(sessionId) ? session.getSnapshot() : undefined,
      dispatch: (command, publish) => session.dispatch(command, publish),
      onShutdown: close,
    })
    session.attachPublisher((type, payload) => {
      server.publish(session.sessionId, type, payload)
    })
  } catch (error) {
    await session.close()
    throw error
  }
  return {
    session,
    server,
    close,
  }
}

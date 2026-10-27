import type { RuntimeClientSession } from '../runtime/client.ts'
import type { RuntimeEventEnvelope } from '../runtime/contracts.ts'
import type { ModelAuthEvent, ModelAuthInteraction, ModelAuthPrompt, ModelAuthProviderDescriptor, ModelAuthStatus, ModelAuthType, ModelCatalogSnapshot } from '../models/contracts.ts'
import type { TuiModelPort, TuiModelSwitchSnapshot } from './modelPort.ts'

interface PendingModelAuthLogin {
  resolve(): void
  reject(error: Error): void
}

/** Pi-free model and authentication facade for the Bun runtime client. */
export class RuntimeModelFacade implements TuiModelPort {
  private readonly unsubscribeRuntime: () => void
  private modelAuthInteraction?: ModelAuthInteraction
  private modelAuthWaiter?: PendingModelAuthLogin
  private readonly promptControllers = new Map<string, AbortController>()

  constructor(private readonly session: RuntimeClientSession) {
    this.unsubscribeRuntime = session.subscribe({ onEvent: (event) => this.onRuntimeEvent(event) })
  }

  getCatalog(): Promise<ModelCatalogSnapshot> {
    return this.session.sendCommand<ModelCatalogSnapshot>('model.catalog')
  }

  async switchModel(modelId: string, api?: string, provider?: string): Promise<TuiModelSwitchSnapshot> {
    const slash = modelId.indexOf('/')
    const id = slash > 0 ? modelId.slice(slash + 1) : modelId
    const providerId = provider ?? (slash > 0 ? modelId.slice(0, slash) : undefined)
    await this.session.sendCommand('model.select', {
      model_id: id,
      ...(api ? { api_id: api } : {}),
      ...(providerId ? { provider_id: providerId } : {}),
    })
    const snapshot = this.session.snapshot
    if (!snapshot) throw new Error('Runtime snapshot has not been loaded.')
    return Object.freeze({
      model: snapshot.model,
      provider: snapshot.model.provider_id,
      apiKeyConfigured: snapshot.model_config.api_key_configured,
      thinkingLevel: snapshot.thinking_level,
    })
  }

  async suggestSessionTitle(openingSentence: string): Promise<string> {
    const result = await this.session.sendCommand<{ title: string }>('session.title.suggest', { opening_sentence: openingSentence })
    return result.title
  }

  listProviders(): Promise<readonly ModelAuthProviderDescriptor[]> {
    return this.session.sendCommand<ModelAuthProviderDescriptor[]>('model.auth.providers')
  }

  getAuthStatus(): Promise<readonly ModelAuthStatus[]> {
    return this.session.sendCommand<ModelAuthStatus[]>('model.auth.status')
  }

  async login(providerId: string, authType: ModelAuthType, interaction: ModelAuthInteraction): Promise<void> {
    if (this.modelAuthInteraction) throw new Error('A provider sign-in flow is already active.')
    if (interaction.signal.aborted) throw interaction.signal.reason ?? new Error('Authentication cancelled.')
    this.modelAuthInteraction = interaction
    let resolveCompletion!: () => void
    let rejectCompletion!: (error: Error) => void
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    const waiter = { resolve: resolveCompletion, reject: rejectCompletion }
    this.modelAuthWaiter = waiter
    const cancelLogin = () => { void this.session.sendCommand('model.auth.cancel').catch(() => undefined) }
    interaction.signal.addEventListener('abort', cancelLogin, { once: true })
    try {
      await this.session.sendCommand('model.auth.login', { provider_id: providerId, auth_type: authType })
      await completion
    } finally {
      interaction.signal.removeEventListener('abort', cancelLogin)
      if (this.modelAuthInteraction === interaction) this.modelAuthInteraction = undefined
      if (this.modelAuthWaiter === waiter) this.modelAuthWaiter = undefined
      for (const controller of this.promptControllers.values()) controller.abort(new Error('Authentication flow ended.'))
      this.promptControllers.clear()
    }
  }

  async logout(providerId: string): Promise<void> {
    await this.session.sendCommand('model.auth.logout', { provider_id: providerId })
  }

  async dispose(): Promise<void> {
    if (this.modelAuthInteraction) await this.session.sendCommand('model.auth.cancel').catch(() => undefined)
    this.unsubscribeRuntime()
    this.modelAuthWaiter?.reject(new Error('Runtime client closed.'))
    this.modelAuthWaiter = undefined
    this.modelAuthInteraction = undefined
    for (const controller of this.promptControllers.values()) controller.abort(new Error('Runtime client closed.'))
    this.promptControllers.clear()
  }

  private onRuntimeEvent(event: RuntimeEventEnvelope): void {
    if (event.type === 'model_auth_prompt') void this.handleModelAuthPrompt(event.payload)
    if (event.type === 'model_auth_prompt_cancelled' && typeof event.payload.request_id === 'string') {
      this.promptControllers.get(event.payload.request_id)?.abort(new Error('Provider no longer needs this auth prompt.'))
    }
    if (event.type === 'model_auth_notification' && this.modelAuthInteraction && isRecord(event.payload.event)) {
      this.modelAuthInteraction.notify(event.payload.event as ModelAuthEvent)
    }
    if (event.type === 'model_auth_complete' && this.modelAuthWaiter) {
      const waiter = this.modelAuthWaiter
      this.modelAuthWaiter = undefined
      if (event.payload.success === true) waiter.resolve()
      else waiter.reject(new Error(typeof event.payload.message === 'string' ? event.payload.message : 'Provider sign-in failed.'))
    }
  }

  private async handleModelAuthPrompt(payload: Record<string, unknown>): Promise<void> {
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : undefined
    const prompt = parseModelAuthPrompt(payload.prompt)
    const interaction = this.modelAuthInteraction
    if (!requestId || !prompt || !interaction) {
      if (requestId) await this.session.sendCommand('model.auth.prompt.resolve', { request_id: requestId, cancel: true }).catch(() => undefined)
      return
    }
    const controller = new AbortController()
    this.promptControllers.set(requestId, controller)
    try {
      const value = await interaction.prompt({ ...prompt, signal: controller.signal })
      await this.session.sendCommand('model.auth.prompt.resolve', { request_id: requestId, value })
    } catch {
      await this.session.sendCommand('model.auth.prompt.resolve', { request_id: requestId, cancel: true }).catch(() => undefined)
    } finally {
      if (this.promptControllers.get(requestId) === controller) this.promptControllers.delete(requestId)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseModelAuthPrompt(value: unknown): ModelAuthPrompt | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') return undefined
  const prompt = {
    message: value.message,
    ...(typeof value.placeholder === 'string' ? { placeholder: value.placeholder } : {}),
  }
  if (value.type === 'text' || value.type === 'secret' || value.type === 'manual_code') {
    return { ...prompt, type: value.type }
  }
  if (value.type !== 'select' || !Array.isArray(value.options)) return undefined
  const options = value.options.flatMap((option) => {
    if (!isRecord(option) || typeof option.id !== 'string' || typeof option.label !== 'string') return []
    return [{ id: option.id, label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
  })
  return options.length === value.options.length ? { ...prompt, type: 'select', options } : undefined
}

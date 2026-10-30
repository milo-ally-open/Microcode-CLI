import { RuntimeServiceClient, RuntimeServiceClientError, RuntimeSnapshotRequiredError } from './transportClient.ts'
import type { RuntimeAgentSnapshot, RuntimeCommandType, RuntimeEventEnvelope } from './contracts.ts'

export interface RuntimeClientSessionCallbacks {
  onSnapshot?(snapshot: RuntimeAgentSnapshot): void
  onEvent?(event: RuntimeEventEnvelope): void
  onConnectionChange?(connected: boolean, error?: Error): void
}

/** Reconnecting, snapshot-aware client for one runtime session. */
export class RuntimeClientSession {
  private snapshotValue?: RuntimeAgentSnapshot
  private sequence = 0
  private sessionIdValue: string
  private readonly controller = new AbortController()
  private eventStreamController?: AbortController
  private eventTask?: Promise<void>
  private started = false
  private closed = false
  private connected = false
  private readonly callbacks = new Set<RuntimeClientSessionCallbacks>()

  constructor(
    readonly client: RuntimeServiceClient,
    sessionId: string,
  ) {
    this.sessionIdValue = sessionId
  }

  get sessionId(): string {
    return this.sessionIdValue
  }

  get snapshot(): RuntimeAgentSnapshot | undefined {
    return this.snapshotValue
  }

  get lastSequence(): number {
    return this.sequence
  }

  get isConnected(): boolean {
    return this.connected
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  subscribe(callbacks: RuntimeClientSessionCallbacks): () => void {
    this.callbacks.add(callbacks)
    return () => this.callbacks.delete(callbacks)
  }

  async start(signal?: AbortSignal): Promise<RuntimeAgentSnapshot> {
    if (this.closed) throw new RuntimeServiceClientError('Runtime client session is closed.', 409, 'session_closed')
    if (signal?.aborted) throw signal.reason
    if (!this.started) {
      this.started = true
      await this.client.handshake(signal)
      await this.refreshSnapshot(signal, true)
      this.notifyConnection(true)
      this.eventTask = this.consumeEvents()
    }
    if (!this.snapshotValue) throw new RuntimeServiceClientError('Runtime snapshot is unavailable.', 502, 'missing_snapshot')
    return this.snapshotValue
  }

  async sendCommand<T = unknown>(type: RuntimeCommandType, payload: Record<string, unknown> = {}): Promise<T> {
    if (!this.started) await this.start()
    if (this.closed) throw new RuntimeServiceClientError('Runtime client session is closed.', 409, 'session_closed')
    const previousSessionId = this.sessionIdValue
    let sessionChanged = false
    let result: T
    try {
      result = await this.client.sendCommand<T>(this.sessionIdValue, type, payload, undefined, this.controller.signal)
    } catch (error) {
      if (type !== 'tool.set' || !(error instanceof RuntimeServiceClientError) || error.code !== 'stale_tool_snapshot') throw error
      const snapshot = await this.refreshSnapshot(this.controller.signal, true)
      const latestVersion = snapshot.tools.version
      if (!Number.isSafeInteger(latestVersion) || latestVersion < 1) throw error
      result = await this.client.sendCommand<T>(this.sessionIdValue, type, {
        ...payload,
        expected_version: latestVersion,
      }, undefined, this.controller.signal)
    }
    if ((type === 'session.clear' || type === 'session.open') && result && typeof result === 'object' && 'session_id' in result
      && typeof (result as { session_id?: unknown }).session_id === 'string') {
      this.sessionIdValue = (result as { session_id: string }).session_id
      if (this.sessionIdValue !== previousSessionId) {
        this.sequence = 0
        sessionChanged = true
        this.eventStreamController?.abort(new Error('Runtime session changed.'))
      }
    }
    await this.refreshSnapshot(this.controller.signal, sessionChanged)
    return result
  }

  async refreshSnapshot(signal?: AbortSignal, advanceSequence = false): Promise<RuntimeAgentSnapshot> {
    const envelope = await this.client.getSnapshotEnvelope<RuntimeAgentSnapshot>(this.sessionIdValue, signal)
    if (advanceSequence) this.sequence = Math.max(this.sequence, envelope.sequence)
    this.snapshotValue = envelope.snapshot
    this.notifySnapshot(this.snapshotValue)
    return this.snapshotValue
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.controller.abort(new Error('Runtime client session closed.'))
    this.eventStreamController?.abort(new Error('Runtime client session closed.'))
    await this.eventTask?.catch(() => undefined)
    this.callbacks.clear()
  }

  private async consumeEvents(): Promise<void> {
    let delayMs = 100
    let connected = this.connected
    while (!this.closed && !this.controller.signal.aborted) {
      const streamController = new AbortController()
      this.eventStreamController = streamController
      const streamSignal = AbortSignal.any([this.controller.signal, streamController.signal])
      const streamSessionId = this.sessionIdValue
      try {
        for await (const event of this.client.events(streamSessionId, this.sequence, streamSignal)) {
          if (streamSessionId !== this.sessionIdValue) break
          if (event.sequence <= this.sequence) continue
          this.sequence = event.sequence
          if (event.type === 'state_changed' && isRuntimeAgentSnapshot(event.payload.snapshot)) {
            const incoming = event.payload.snapshot
            this.snapshotValue = this.snapshotValue
              ? { ...incoming, messages: this.snapshotValue.messages }
              : incoming
            this.notifySnapshot(this.snapshotValue)
          } else if (event.type === 'agent_start' && this.snapshotValue) {
            this.snapshotValue = { ...this.snapshotValue, is_streaming: true }
          } else if (event.type === 'agent_end' && this.snapshotValue) {
            this.snapshotValue = { ...this.snapshotValue, is_streaming: false, pending_tool_call_count: 0 }
          }
          if (event.type === 'capabilities_changed') {
            await this.refreshSnapshot(this.controller.signal, true).catch(() => undefined)
          }
          for (const callback of [...this.callbacks]) {
            try { callback.onEvent?.(event) } catch { /* A view callback cannot stop event delivery. */ }
          }
          connected = true
          delayMs = 100
          if (event.type === 'agent_end' || event.type === 'turn_end') {
            void this.refreshSnapshot(this.controller.signal).catch(() => undefined)
          }
        }
        if (!this.closed && !this.controller.signal.aborted) {
          throw new RuntimeServiceClientError('Runtime event stream ended.', 503, 'event_stream_ended')
        }
      } catch (error) {
        if (this.closed || this.controller.signal.aborted) break
        if (streamController.signal.aborted) continue
        if (error instanceof RuntimeSnapshotRequiredError) {
          try {
            await this.refreshSnapshot(this.controller.signal, true)
            connected = true
            delayMs = 100
          } catch (snapshotError) {
            this.notifyConnection(false, toError(snapshotError))
            await sleep(delayMs, this.controller.signal)
          }
          continue
        }
        const normalized = toError(error)
        if (connected) {
          connected = false
          this.notifyConnection(false, normalized)
        }
        await sleep(delayMs, this.controller.signal)
        delayMs = Math.min(delayMs * 2, 2_000)
        try {
          await this.refreshSnapshot(this.controller.signal, true)
          this.notifyConnection(true)
          connected = true
        } catch (snapshotError) {
          if (!this.controller.signal.aborted) this.notifyConnection(false, toError(snapshotError))
        }
      } finally {
        if (this.eventStreamController === streamController) this.eventStreamController = undefined
      }
    }
  }

  private notifyConnection(connected: boolean, error?: Error): void {
    this.connected = connected
    for (const callback of [...this.callbacks]) {
      try { callback.onConnectionChange?.(connected, error) } catch { /* A view callback cannot stop reconnects. */ }
    }
  }

  private notifySnapshot(snapshot: RuntimeAgentSnapshot): void {
    for (const callback of [...this.callbacks]) {
      try { callback.onSnapshot?.(snapshot) } catch { /* A view callback cannot stop snapshot recovery. */ }
    }
  }
}

function isRuntimeAgentSnapshot(value: unknown): value is RuntimeAgentSnapshot {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && 'messages' in value && Array.isArray((value as RuntimeAgentSnapshot).messages)
    && 'tools' in value && 'model' in value)
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

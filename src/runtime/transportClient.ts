import { randomUUID } from 'node:crypto'
import {
  RUNTIME_SERVICE_PROTOCOL_VERSION,
  type RuntimeCommandAck,
  type RuntimeCommandEnvelope,
  type RuntimeCommandType,
  type RuntimeEventEnvelope,
  type RuntimeSnapshotEnvelope,
} from './contracts.ts'

export class RuntimeServiceClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'RuntimeServiceClientError'
  }
}

export class RuntimeSnapshotRequiredError extends RuntimeServiceClientError {
  constructor(readonly latestSequence: number) {
    super('The runtime event window expired; fetch a fresh snapshot before reconnecting.', 409, 'snapshot_required')
    this.name = 'RuntimeSnapshotRequiredError'
  }
}

export class RuntimeServiceClient {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async handshake(signal?: AbortSignal): Promise<{ protocolVersion: number }> {
    const body = await this.requestJson('/runtime/v1/handshake', { method: 'GET', signal })
    if (body.protocol_version !== RUNTIME_SERVICE_PROTOCOL_VERSION) {
      throw new RuntimeServiceClientError('Runtime service protocol version is incompatible.', 409, 'protocol_mismatch')
    }
    return { protocolVersion: body.protocol_version }
  }

  async getSnapshot<T = unknown>(sessionId: string, signal?: AbortSignal): Promise<T> {
    return (await this.getSnapshotEnvelope<T>(sessionId, signal)).snapshot
  }

  async getSnapshotEnvelope<T = unknown>(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ snapshot: T; sequence: number }> {
    const query = new URLSearchParams({ session_id: sessionId })
    const body = await this.requestJson(`/runtime/v1/snapshot?${query}`, { method: 'GET', signal })
    if (body.protocol_version !== RUNTIME_SERVICE_PROTOCOL_VERSION || body.session_id !== sessionId
      || !Number.isSafeInteger(body.sequence) || (body.sequence as number) < 0) {
      throw new RuntimeServiceClientError('Runtime snapshot envelope is incompatible.', 502, 'invalid_snapshot')
    }
    return { snapshot: body.snapshot as T, sequence: body.sequence as number }
  }

  async shutdown(signal?: AbortSignal): Promise<void> {
    const body = await this.requestJson('/runtime/v1/shutdown', { method: 'POST', signal })
    if (body.accepted !== true || body.protocol_version !== RUNTIME_SERVICE_PROTOCOL_VERSION) {
      throw new RuntimeServiceClientError('Runtime shutdown acknowledgement is incompatible.', 502, 'invalid_ack')
    }
  }

  async sendCommand<T = unknown>(
    sessionId: string,
    type: RuntimeCommandType,
    payload: Record<string, unknown> = {},
    requestId = randomUUID(),
    signal?: AbortSignal,
  ): Promise<T> {
    const command: RuntimeCommandEnvelope = {
      protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION,
      request_id: requestId,
      session_id: sessionId,
      command: { type, payload },
    }
    const body = await this.requestJson('/runtime/v1/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal,
    })
    if (body.protocol_version !== RUNTIME_SERVICE_PROTOCOL_VERSION
      || body.request_id !== requestId
      || body.session_id !== sessionId
      || body.accepted !== true) {
      throw new RuntimeServiceClientError('Runtime command acknowledgement is incompatible.', 502, 'invalid_ack')
    }
    return body.result as T
  }

  async *events(
    sessionId: string,
    lastSequence = 0,
    signal?: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RuntimeEventEnvelope> {
    const query = new URLSearchParams({ session_id: sessionId })
    const response = await this.fetchImpl(`${this.baseUrl}/runtime/v1/events?${query}`, {
      method: 'GET',
      headers: this.authHeaders({ 'last-event-id': String(lastSequence) }),
      signal,
    })
    if (response.status === 409) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>
      if (body.snapshot_required === true && typeof body.latest_sequence === 'number') {
        throw new RuntimeSnapshotRequiredError(body.latest_sequence)
      }
    }
    if (!response.ok) throw await this.clientError(response)
    if (!response.body) throw new RuntimeServiceClientError('Runtime event stream has no body.', 502, 'missing_event_stream')
    onOpen?.()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (data) {
            const event = parseEvent(JSON.parse(data) as unknown, sessionId)
            yield event
          }
          boundary = buffer.indexOf('\n\n')
        }
        if (done) return
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private authHeaders(headers: HeadersInit = {}): Headers {
    const result = new Headers(headers)
    result.set('authorization', `Bearer ${this.token}`)
    return result
  }

  private async requestJson(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.authHeaders(init.headers),
    })
    const body = await response.json().catch(() => ({})) as unknown
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body
        ? (body as { error?: { message?: unknown; code?: unknown } }).error
        : undefined
      throw new RuntimeServiceClientError(
        typeof error?.message === 'string' ? error.message : 'Runtime service request failed.',
        response.status,
        typeof error?.code === 'string' ? error.code : undefined,
      )
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RuntimeServiceClientError('Runtime service returned a malformed response.', 502, 'invalid_response')
    }
    return body as Record<string, unknown>
  }

  private async clientError(response: Response): Promise<RuntimeServiceClientError> {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {}
    return new RuntimeServiceClientError(
      typeof error.message === 'string' ? error.message : 'Runtime service request failed.',
      response.status,
      typeof error.code === 'string' ? error.code : undefined,
    )
  }
}

function parseEvent(value: unknown, sessionId: string): RuntimeEventEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeServiceClientError('Runtime event is malformed.', 502, 'invalid_event')
  }
  const event = value as Partial<RuntimeEventEnvelope>
  if (event.protocol_version !== RUNTIME_SERVICE_PROTOCOL_VERSION
    || event.session_id !== sessionId
    || !Number.isSafeInteger(event.sequence)
    || typeof event.type !== 'string'
    || !event.payload
    || typeof event.payload !== 'object'
    || Array.isArray(event.payload)) {
    throw new RuntimeServiceClientError('Runtime event envelope is incompatible.', 502, 'invalid_event')
  }
  return event as RuntimeEventEnvelope
}

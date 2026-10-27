import { timingSafeEqual } from 'node:crypto'
import {
  RUNTIME_SERVICE_PROTOCOL_VERSION,
  type RuntimeCommandAck,
  type RuntimeCommandEnvelope,
  type RuntimeEventEnvelope,
  type RuntimeServiceServerHandle,
  type RuntimeServiceServerOptions,
  type RuntimeSnapshotEnvelope,
} from './types.ts'

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
const DEFAULT_MAX_EVENTS_PER_SESSION = 512
const DEFAULT_MAX_CACHED_COMMANDS = 1024
const DEFAULT_COMMAND_CACHE_TTL_MS = 5 * 60 * 1000
const COMMAND_TYPES = new Set([
  'prompt', 'prompt.read_only', 'abort', 'model.catalog', 'model.select', 'model.auth.providers', 'model.auth.status',
  'model.auth.login', 'model.auth.prompt.resolve', 'model.auth.cancel', 'model.auth.logout', 'session.title.suggest', 'thinking.set', 'permission.set',
  'permission.resolve', 'question.resolve', 'tool.set', 'session.clear',
  'permission.check', 'permission.request', 'permission.rule.add',
  'session.list', 'session.open', 'session.title.set', 'session.tasks.list',
  'session.tasks.remind', 'session.export', 'session.compact', 'skill.set',
  'plugin.refresh', 'plugin.set', 'plugin.set_many', 'mcp.refresh',
  'git.status', 'git.branches', 'git.diff', 'git.history', 'git.stage', 'git.unstage', 'git.discard', 'git.commit',
  'git.branch.switch', 'git.branch.create', 'git.branch.delete', 'git.fetch', 'git.pull', 'git.push',
  'git.stash.push', 'git.stash.list', 'git.stash.apply',
  'instructions.init.propose', 'instructions.init.apply', 'instructions.reload',
])

interface CachedResponse {
  status: number
  body: Record<string, unknown>
}

interface CachedCommand {
  expiresAt: number
  settled: boolean
  result: Promise<CachedResponse>
}

interface EventStreamResult {
  events: RuntimeEventEnvelope[]
  stale: boolean
  latestSequence: number
}

export class RuntimeServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'invalid_command',
  ) {
    super(message)
    this.name = 'RuntimeServiceError'
  }
}

class RuntimeEventHub {
  private readonly sequences = new Map<string, number>()
  private readonly history = new Map<string, RuntimeEventEnvelope[]>()
  private readonly listeners = new Map<string, Set<(event: RuntimeEventEnvelope) => void>>()

  constructor(private readonly maxEventsPerSession: number) {}

  publish(sessionId: string, type: string, payload: Record<string, unknown>): RuntimeEventEnvelope {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(type)) {
      throw new RuntimeServiceError('Event type is invalid.')
    }
    const safePayload = cloneJsonObject(payload, 'Event payload')
    const sequence = (this.sequences.get(sessionId) ?? 0) + 1
    const event: RuntimeEventEnvelope = Object.freeze({
      protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION,
      session_id: sessionId,
      sequence,
      type,
      payload: Object.freeze(safePayload),
    })
    this.sequences.set(sessionId, sequence)
    const history = this.history.get(sessionId) ?? []
    history.push(event)
    if (history.length > this.maxEventsPerSession) history.splice(0, history.length - this.maxEventsPerSession)
    this.history.set(sessionId, history)
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) {
      try { listener(event) } catch { /* A disconnected subscriber cannot interrupt runtime event delivery. */ }
    }
    return event
  }

  after(sessionId: string, sequence: number): EventStreamResult {
    const history = this.history.get(sessionId) ?? []
    const latestSequence = this.sequences.get(sessionId) ?? 0
    const earliestSequence = history[0]?.sequence ?? latestSequence + 1
    return {
      events: history.filter((event) => event.sequence > sequence),
      stale: sequence < earliestSequence - 1,
      latestSequence,
    }
  }

  latest(sessionId: string): number {
    return this.sequences.get(sessionId) ?? 0
  }

  subscribe(sessionId: string, listener: (event: RuntimeEventEnvelope) => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

function authorized(request: Request, expected: string): boolean {
  const authorization = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (!match) return false
  const supplied = Buffer.from(match[1]!)
  const expectedBytes = Buffer.from(expected)
  return supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes)
}

function cloneJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeServiceError(`${label} must be a JSON object.`)
  }
  try {
    const clone = JSON.parse(JSON.stringify(value)) as unknown
    if (!clone || typeof clone !== 'object' || Array.isArray(clone)) throw new Error('not object')
    return clone as Record<string, unknown>
  } catch {
    throw new RuntimeServiceError(`${label} must contain JSON-serializable values.`)
  }
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new RuntimeServiceError('Request body exceeds the configured size limit.', 413, 'request_too_large')
  }
  if (!request.body) throw new RuntimeServiceError('Request body is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new RuntimeServiceError('Request body exceeds the configured size limit.', 413, 'request_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new RuntimeServiceError('Request body must be valid UTF-8 JSON.')
  }
}

function parseCommand(value: unknown): RuntimeCommandEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeServiceError('Command envelope must be a JSON object.')
  }
  const body = value as Record<string, unknown>
  if (body.protocol_version !== RUNTIME_SERVICE_PROTOCOL_VERSION) {
    throw new RuntimeServiceError('Runtime service protocol version is incompatible.', 409, 'protocol_mismatch')
  }
  if (typeof body.request_id !== 'string' || !/^[\w.-]{1,128}$/.test(body.request_id)) {
    throw new RuntimeServiceError('request_id must be a 1–128 character request token.')
  }
  if (typeof body.session_id !== 'string' || !/^[\w.-]{1,128}$/.test(body.session_id)) {
    throw new RuntimeServiceError('session_id must be a 1–128 character session token.')
  }
  if (!body.command || typeof body.command !== 'object' || Array.isArray(body.command)) {
    throw new RuntimeServiceError('command must be a JSON object.')
  }
  const command = body.command as Record<string, unknown>
  if (typeof command.type !== 'string' || !COMMAND_TYPES.has(command.type)) {
    throw new RuntimeServiceError('Command type is not supported.', 400, 'unknown_command')
  }
  const payload = cloneJsonObject(command.payload ?? {}, 'Command payload')
  return {
    protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION,
    request_id: body.request_id,
    session_id: body.session_id,
    command: { type: command.type as RuntimeCommandEnvelope['command']['type'], payload },
  }
}

function parseSequence(value: string | null): number {
  if (value === null || value === '') return 0
  if (!/^\d{1,16}$/.test(value)) throw new RuntimeServiceError('Event sequence must be a non-negative integer.')
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence)) throw new RuntimeServiceError('Event sequence is outside the supported range.')
  return sequence
}

function encodeEvent(event: RuntimeEventEnvelope): Uint8Array {
  return new TextEncoder().encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function loopbackHostname(value: string | undefined): string {
  const hostname = value ?? '127.0.0.1'
  if (hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new Error('Runtime service may only bind to the IPv4 or IPv6 loopback address.')
  }
  return hostname
}

export function createRuntimeServiceServer(options: RuntimeServiceServerOptions): RuntimeServiceServerHandle {
  if (!options.token || options.token.length < 24) throw new Error('Runtime service token must contain at least 24 characters.')
  const hostname = loopbackHostname(options.hostname)
  const port = options.port ?? 43128
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Runtime service port is invalid.')
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  const maxEventsPerSession = options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION
  const maxCachedCommands = options.maxCachedCommands ?? DEFAULT_MAX_CACHED_COMMANDS
  const cacheTtlMs = options.commandCacheTtlMs ?? DEFAULT_COMMAND_CACHE_TTL_MS
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error('Runtime service request limit is invalid.')
  if (!Number.isInteger(maxEventsPerSession) || maxEventsPerSession < 1) throw new Error('Runtime service event window is invalid.')
  if (!Number.isInteger(maxCachedCommands) || maxCachedCommands < 1) throw new Error('Runtime service command cache limit is invalid.')
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 1000) throw new Error('Runtime service command cache TTL is invalid.')
  const eventHub = new RuntimeEventHub(maxEventsPerSession)
  const commandCache = new Map<string, CachedCommand>()
  const commandQueues = new Map<string, Promise<void>>()

  function pruneCache(): void {
    const now = Date.now()
    for (const [key, entry] of commandCache) {
      if (entry.settled && entry.expiresAt <= now) commandCache.delete(key)
    }
    while (commandCache.size > maxCachedCommands) {
      const oldest = [...commandCache].find(([, entry]) => entry.settled)?.[0]
      if (!oldest) break
      commandCache.delete(oldest)
    }
  }

  function dispatchInOrder(sessionId: string, work: () => Promise<CachedResponse>): Promise<CachedResponse> {
    const previous = commandQueues.get(sessionId) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tail = result.then(() => undefined, () => undefined)
    commandQueues.set(sessionId, tail)
    void tail.then(() => {
      if (commandQueues.get(sessionId) === tail) commandQueues.delete(sessionId)
    })
    return result
  }

  async function commandResponse(command: RuntimeCommandEnvelope): Promise<CachedResponse> {
    const key = `${command.session_id}\0${command.request_id}`
    pruneCache()
    const cached = commandCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.result

    const result = dispatchInOrder(command.session_id, async () => {
      try {
        if (await options.getSnapshot(command.session_id) === undefined) {
          return { status: 404, body: { error: { code: 'session_not_found', message: 'Runtime session was not found.' } } }
        }
        const result = await options.dispatch(command, (type, payload) => eventHub.publish(command.session_id, type, payload))
        const ack: RuntimeCommandAck = {
          protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION,
          request_id: command.request_id,
          session_id: command.session_id,
          accepted: true,
          ...(result === undefined ? {} : { result }),
        }
        const safeAck = JSON.parse(JSON.stringify(ack)) as Record<string, unknown>
        return { status: 200, body: safeAck }
      } catch (error) {
        if (error instanceof RuntimeServiceError) {
          return { status: error.status, body: { error: { code: error.code, message: error.message } } }
        }
        return { status: 500, body: { error: { code: 'runtime_command_failed', message: 'Runtime command failed.' } } }
      }
    })
    const entry: CachedCommand = { expiresAt: Number.POSITIVE_INFINITY, settled: false, result }
    commandCache.set(key, entry)
    void result.then(() => {
      entry.settled = true
      entry.expiresAt = Date.now() + cacheTtlMs
      pruneCache()
    })
    pruneCache()
    return result
  }

  const server = Bun.serve({
    hostname,
    port,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/runtime/v1/health' && request.method === 'GET') {
        return json({ ok: true, protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION })
      }
      if (!authorized(request, options.token)) {
        return json({ error: { code: 'unauthorized', message: 'Runtime service authentication failed.' } }, 401, { 'www-authenticate': 'Bearer' })
      }
      if (url.pathname === '/runtime/v1/handshake' && request.method === 'GET') {
        return json({ ok: true, protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION })
      }
      if (url.pathname === '/runtime/v1/shutdown' && request.method === 'POST') {
        setTimeout(() => {
          if (options.onShutdown) void Promise.resolve(options.onShutdown()).catch(() => undefined)
          else void server.stop(true)
        }, 50)
        return json({ accepted: true, protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION })
      }
      if (url.pathname === '/runtime/v1/snapshot' && request.method === 'GET') {
        const sessionId = url.searchParams.get('session_id')
        if (!sessionId || !/^[\w.-]{1,128}$/.test(sessionId)) {
          return json({ error: { code: 'invalid_session_id', message: 'session_id is required.' } }, 400)
        }
        let snapshot: unknown | undefined
        try { snapshot = await options.getSnapshot(sessionId) } catch {
          return json({ error: { code: 'snapshot_failed', message: 'Runtime snapshot could not be read.' } }, 500)
        }
        if (snapshot === undefined) return json({ error: { code: 'session_not_found', message: 'Runtime session was not found.' } }, 404)
        try {
          const envelope: RuntimeSnapshotEnvelope = {
            protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION,
            session_id: sessionId,
            sequence: eventHub.latest(sessionId),
            snapshot: JSON.parse(JSON.stringify(snapshot)) as unknown,
          }
          return json(envelope)
        } catch {
          return json({ error: { code: 'invalid_snapshot', message: 'Runtime snapshot is not JSON serializable.' } }, 500)
        }
      }
      if (url.pathname === '/runtime/v1/commands' && request.method === 'POST') {
        try {
          const command = parseCommand(await readJson(request, maxRequestBytes))
          const result = await commandResponse(command)
          return json(result.body, result.status)
        } catch (error) {
          if (error instanceof RuntimeServiceError) {
            return json({ error: { code: error.code, message: error.message } }, error.status)
          }
          return json({ error: { code: 'invalid_command', message: 'Command could not be processed.' } }, 400)
        }
      }
      if (url.pathname === '/runtime/v1/events' && request.method === 'GET') {
        return await eventResponse(request, url, eventHub, options.getSnapshot)
      }
      return json({ error: { code: 'not_found', message: 'Runtime service endpoint was not found.' } }, 404)
    },
  })

  async function eventResponse(
    request: Request,
    url: URL,
    hub: RuntimeEventHub,
    getSnapshot: RuntimeServiceServerOptions['getSnapshot'],
  ): Promise<Response> {
    const sessionId = url.searchParams.get('session_id')
    if (!sessionId || !/^[\w.-]{1,128}$/.test(sessionId)) {
      return json({ error: { code: 'invalid_session_id', message: 'session_id is required.' } }, 400)
    }
    let snapshot: unknown | undefined
    try { snapshot = await getSnapshot(sessionId) } catch {
      return json({ error: { code: 'snapshot_failed', message: 'Runtime snapshot could not be read.' } }, 500)
    }
    if (snapshot === undefined) {
      return json({ error: { code: 'session_not_found', message: 'Runtime session was not found.' } }, 404)
    }
    let lastSequence: number
    try {
      lastSequence = parseSequence(request.headers.get('last-event-id') ?? url.searchParams.get('last_sequence'))
    } catch (error) {
      const serviceError = error instanceof RuntimeServiceError ? error : new RuntimeServiceError('Event sequence is invalid.')
      return json({ error: { code: serviceError.code, message: serviceError.message } }, serviceError.status)
    }
    const replay = hub.after(sessionId, lastSequence)
    if (replay.stale) {
      return json({
        snapshot_required: true,
        protocol_version: RUNTIME_SERVICE_PROTOCOL_VERSION,
        session_id: sessionId,
        latest_sequence: replay.latestSequence,
      }, 409)
    }

    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        let unsubscribe = () => {}
        const close = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          unsubscribe()
          request.signal.removeEventListener('abort', close)
          try { controller.close() } catch { /* The response may already be closed by the client. */ }
        }
        for (const event of replay.events) controller.enqueue(encodeEvent(event))
        unsubscribe = hub.subscribe(sessionId, (event) => {
          if (!closed && event.sequence > lastSequence) {
            try { controller.enqueue(encodeEvent(event)) } catch { close() }
          }
        })
        const heartbeat = setInterval(() => {
          if (!closed) {
            try { controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')) } catch { close() }
          }
        }, 20_000)
        request.signal.addEventListener('abort', close, { once: true })
        cleanup = close
      },
      cancel() { cleanup() },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
      },
    })
  }

  return {
    hostname: server.hostname ?? hostname,
    port: server.port ?? port,
    publish: (sessionId, type, payload) => eventHub.publish(sessionId, type, payload),
    stop: () => server.stop(true),
  }
}

import type { RuntimeCommandEnvelope, RuntimeEventEnvelope } from '../../runtime/contracts.ts'

export {
  RUNTIME_SERVICE_PROTOCOL_VERSION,
  type RuntimeCommandAck,
  type RuntimeCommandEnvelope,
  type RuntimeCommandType,
  type RuntimeEventEnvelope,
  type RuntimeSnapshotEnvelope,
} from '../../runtime/contracts.ts'

export interface RuntimeServiceServerHandle {
  readonly hostname: string
  readonly port: number
  publish(sessionId: string, type: string, payload: Record<string, unknown>): RuntimeEventEnvelope
  stop(): Promise<void> | void
}

export interface RuntimeServiceServerOptions {
  token: string
  hostname?: string
  port?: number
  maxRequestBytes?: number
  maxEventsPerSession?: number
  maxCachedCommands?: number
  commandCacheTtlMs?: number
  getSnapshot(sessionId: string): unknown | undefined | Promise<unknown | undefined>
  dispatch(
    command: RuntimeCommandEnvelope,
    publish: (type: string, payload: Record<string, unknown>) => RuntimeEventEnvelope,
  ): unknown | Promise<unknown>
  onShutdown?: () => void | Promise<void>
}

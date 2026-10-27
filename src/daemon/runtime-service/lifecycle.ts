import { spawn } from 'node:child_process'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { RuntimeServiceClient } from '../../runtime/transportClient.ts'
import {
  ensureRuntimeDirectory,
  getOrCreateRuntimeToken,
  getRuntimeLockPath,
  readRuntimeMetadata,
  readRuntimeToken,
  removeRuntimeMetadata,
  runtimeInstanceKey,
  type RuntimeDaemonMetadata,
} from './config.ts'
import type { RuntimeThinkingLevel } from '../../runtime/contracts.ts'

export interface RuntimeConnection {
  readonly key: string
  readonly baseUrl: string
  readonly token: string
  readonly sessionId: string
  readonly cwd: string
  readonly metadata: RuntimeDaemonMetadata
  readonly client: RuntimeServiceClient
}

export interface EnsureRuntimeOptions {
  resumeSessionId?: string
  resumeLatest?: boolean
  modelId?: string
  permissionMode?: string
  thinkingLevel?: RuntimeThinkingLevel
  startupTimeoutMs?: number
}

function metadataBaseUrl(metadata: RuntimeDaemonMetadata): string {
  return `http://${metadata.hostname}:${metadata.port}`
}

async function acquireRuntimeLock(key: string): Promise<() => Promise<void>> {
  await ensureRuntimeDirectory(key)
  const path = getRuntimeLockPath(key)
  const handle = await open(path, 'a', 0o600)
  await handle.close()
  return lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 40, minTimeout: 25, maxTimeout: 50, factor: 1 },
  })
}

function spawnRuntimeDaemon(key: string, cwd: string, options: EnsureRuntimeOptions): void {
  const entry = process.argv[1]
  const args = entry && /\.(?:[cm]?js|tsx?)$/i.test(entry) ? [entry] : []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MICROCODE_RUNTIME_CHILD: '1',
    MICROCODE_RUNTIME_KEY: key,
    MICROCODE_RUNTIME_CWD: cwd,
    MICROCODE_RUNTIME_PORT: '0',
    ...(options.resumeSessionId ? { MICROCODE_RUNTIME_RESUME_SESSION_ID: options.resumeSessionId } : {}),
    ...(options.resumeLatest ? { MICROCODE_RUNTIME_RESUME_LATEST: '1' } : {}),
    ...(options.modelId ? { MICROCODE_RUNTIME_MODEL_ID: options.modelId } : {}),
    ...(options.permissionMode ? { MICROCODE_RUNTIME_PERMISSION_MODE: options.permissionMode } : {}),
    ...(options.thinkingLevel ? { MICROCODE_RUNTIME_THINKING_LEVEL: options.thinkingLevel } : {}),
  }
  const child = spawn(process.execPath, args, {
    cwd: homedir(),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => undefined)
  child.unref()
}

async function connectIfReady(
  key: string,
  cwd: string,
  options: EnsureRuntimeOptions,
): Promise<RuntimeConnection | undefined> {
  const metadata = await readRuntimeMetadata(key)
  if (!metadata || metadata.state !== 'ready' || metadata.cwd !== cwd || metadata.protocolVersion !== 1) return undefined
  if (options.resumeSessionId && !metadata.sessionId.startsWith(options.resumeSessionId)) return undefined
  const token = await readRuntimeToken(key)
  const baseUrl = metadataBaseUrl(metadata)
  const client = new RuntimeServiceClient(baseUrl, token)
  try {
    await client.handshake(AbortSignal.timeout(700))
    await client.getSnapshot(metadata.sessionId, AbortSignal.timeout(1000))
    return { key, baseUrl, token, sessionId: metadata.sessionId, cwd, metadata, client }
  } catch {
    return undefined
  }
}

async function waitForRuntime(key: string, cwd: string, options: EnsureRuntimeOptions): Promise<RuntimeConnection> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? 12_000)
  while (Date.now() < deadline) {
    const connection = await connectIfReady(key, cwd, options)
    if (connection) return connection
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Microcode runtime service did not become ready for ${cwd}.`)
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Start or reuse a project-scoped loopback Agent runtime and perform a version handshake. */
export async function ensureRuntimeService(
  cwd = process.cwd(),
  options: EnsureRuntimeOptions = {},
): Promise<RuntimeConnection> {
  const canonicalCwd = await realpath(cwd)
  const key = runtimeInstanceKey(canonicalCwd, options.resumeSessionId)
  const release = await acquireRuntimeLock(key)
  try {
    const existing = await connectIfReady(key, canonicalCwd, options)
    if (existing) return existing
    const metadata = await readRuntimeMetadata(key)
    if (metadata && processIsRunning(metadata.pid)) {
      if (metadata.state === 'starting') return await waitForRuntime(key, canonicalCwd, options)
      throw new Error(`A Microcode runtime process (PID ${metadata.pid}) is present but failed its authenticated handshake. Stop that runtime before starting another.`)
    }
    await removeRuntimeMetadata(key)
    await getOrCreateRuntimeToken(key)
    spawnRuntimeDaemon(key, canonicalCwd, options)
    return await waitForRuntime(key, canonicalCwd, options)
  } finally {
    await release()
  }
}

export async function stopRuntimeService(connection: RuntimeConnection): Promise<boolean> {
  try {
    await connection.client.shutdown(AbortSignal.timeout(2000))
  } catch (error) {
    if (!(error instanceof Error) || !('status' in error && (error as { status?: number }).status === 404)) throw error
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await fetch(`${connection.baseUrl}/runtime/v1/health`, { signal: AbortSignal.timeout(200) })
    } catch {
      await removeRuntimeMetadata(connection.key, connection.metadata.pid)
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The runtime service accepted the stop request but is still responding.')
}

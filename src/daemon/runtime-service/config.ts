import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeServiceServerHandle } from './types.ts'
import { RUNTIME_SERVICE_PROTOCOL_VERSION } from './types.ts'

export interface RuntimeDaemonMetadata {
  state: 'starting' | 'ready'
  pid: number
  hostname: '127.0.0.1'
  port: number
  protocolVersion: number
  startedAt: number
  cwd: string
  sessionId: string
}

export function runtimeInstanceKey(cwd: string, resumeSessionId?: string): string {
  const identity = `${process.platform === 'win32' ? cwd.toLowerCase() : cwd}\0${resumeSessionId ?? 'active'}`
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

function runtimeDirectory(key: string): string {
  if (!/^[a-f\d]{24}$/.test(key)) throw new Error('Runtime instance key is invalid.')
  return join(homedir(), '.microcode', 'runtime', key)
}

export function getRuntimeMetadataPath(key: string): string {
  return join(runtimeDirectory(key), 'daemon.json')
}

export function getRuntimeTokenPath(key: string): string {
  return join(runtimeDirectory(key), 'token')
}

export function getRuntimeLockPath(key: string): string {
  return join(runtimeDirectory(key), 'startup.lock-target')
}

export async function ensureRuntimeDirectory(key: string): Promise<void> {
  const directory = runtimeDirectory(key)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
}

export async function getOrCreateRuntimeToken(key: string): Promise<string> {
  await ensureRuntimeDirectory(key)
  const path = getRuntimeTokenPath(key)
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length >= 24) {
      if (process.platform !== 'win32') await chmod(path, 0o600)
      return existing
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const candidate = randomBytes(32).toString('hex')
  try {
    const handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(`${candidate}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (process.platform !== 'win32') await chmod(path, 0o600)
    return candidate
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = (await readFile(path, 'utf8')).trim()
    if (raced.length < 24) throw new Error('Runtime daemon token could not be initialized safely.')
    return raced
  }
}

export async function readRuntimeToken(key: string): Promise<string> {
  const token = (await readFile(getRuntimeTokenPath(key), 'utf8')).trim()
  if (token.length < 24) throw new Error('Runtime daemon token is missing or invalid.')
  return token
}

export async function readRuntimeMetadata(key: string): Promise<RuntimeDaemonMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(getRuntimeMetadataPath(key), 'utf8')) as Partial<RuntimeDaemonMetadata>
    if ((value.state !== 'starting' && value.state !== 'ready')
      || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1
      || value.hostname !== '127.0.0.1'
      || !Number.isSafeInteger(value.port) || (value.port ?? -1) < 0 || (value.port ?? 65536) > 65535
      || (value.state === 'ready' && value.port === 0)
      || !Number.isSafeInteger(value.protocolVersion) || value.protocolVersion !== RUNTIME_SERVICE_PROTOCOL_VERSION
      || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
      || typeof value.cwd !== 'string' || value.cwd.length === 0
      || typeof value.sessionId !== 'string'
      || (value.state === 'starting' && value.sessionId !== '')) return undefined
    return value as RuntimeDaemonMetadata
  } catch {
    return undefined
  }
}

export async function writeRuntimeMetadata(key: string, metadata: RuntimeDaemonMetadata): Promise<void> {
  await ensureRuntimeDirectory(key)
  const path = getRuntimeMetadataPath(key)
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    await rename(temp, path)
    if (process.platform !== 'win32') await chmod(path, 0o600)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}

export async function removeRuntimeMetadata(key: string, pid?: number): Promise<void> {
  if (pid !== undefined) {
    const current = await readRuntimeMetadata(key)
    if (current && current.pid !== pid) return
  }
  await unlink(getRuntimeMetadataPath(key)).catch(() => undefined)
}

export function runtimeMetadataForServer(
  server: RuntimeServiceServerHandle,
  cwd: string,
  sessionId: string,
): RuntimeDaemonMetadata {
  return {
    state: 'ready',
    pid: process.pid,
    hostname: '127.0.0.1',
    port: server.port,
    protocolVersion: RUNTIME_SERVICE_PROTOCOL_VERSION,
    startedAt: Date.now(),
    cwd,
    sessionId,
  }
}

export function runtimeStartingMetadata(cwd: string): RuntimeDaemonMetadata {
  return {
    state: 'starting',
    pid: process.pid,
    hostname: '127.0.0.1',
    port: 0,
    protocolVersion: RUNTIME_SERVICE_PROTOCOL_VERSION,
    startedAt: Date.now(),
    cwd,
    sessionId: '',
  }
}

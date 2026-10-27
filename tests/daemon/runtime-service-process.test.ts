import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeServiceClient } from '../../src/runtime/transportClient.ts'
import { getOrCreateRuntimeToken, readRuntimeMetadata, removeRuntimeMetadata, runtimeInstanceKey } from '../../src/daemon/runtime-service/config.ts'

setDefaultTimeout(60_000)

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const entryPath = join(projectRoot, 'src', 'entry.ts')
let child: ChildProcess | undefined
let tempRoot: string | undefined
let previousHome: string | undefined
let previousUserProfile: string | undefined

afterEach(async () => {
  if (child && child.exitCode === null) child.kill()
  child = undefined
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  tempRoot = undefined
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
  previousHome = undefined
  previousUserProfile = undefined
})

function launchRuntime(cwd: string, key: string): { process: ChildProcess; output: () => string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homedir(),
    USERPROFILE: homedir(),
    MICROCODE_RUNTIME_CHILD: '1',
    MICROCODE_RUNTIME_KEY: key,
    MICROCODE_RUNTIME_CWD: cwd,
    MICROCODE_RUNTIME_PORT: '0',
    TERM: 'dumb',
  }
  const runtimeProcess = spawn(process.execPath, [entryPath], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  runtimeProcess.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  runtimeProcess.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  return { process: runtimeProcess, output: () => output }
}

async function waitForReady(key: string, runtimeProcess: ChildProcess, output: () => string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (runtimeProcess.exitCode !== null) throw new Error(`Runtime child exited before ready (${runtimeProcess.exitCode}): ${output().slice(-2000)}`)
    const metadata = await readRuntimeMetadata(key)
    if (metadata?.state === 'ready') return metadata
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Runtime child did not become ready: ${output().slice(-2000)}`)
}

async function waitForExit(runtimeProcess: ChildProcess, output: () => string): Promise<number | null> {
  if (runtimeProcess.exitCode !== null) return runtimeProcess.exitCode
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Runtime child did not exit after authenticated shutdown: ${output().slice(-2000)}`)), 8_000)
    runtimeProcess.once('exit', (code) => { clearTimeout(timer); resolve(code) })
    runtimeProcess.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

async function nextEventOf<T extends { type: string }>(
  iterator: AsyncIterator<T>,
  type: string,
): Promise<T & { sequence?: number }> {
  while (true) {
    const result = await iterator.next()
    if (result.done) throw new Error(`Runtime event stream ended before ${type}.`)
    if (result.value.type === type) return result.value as T & { sequence?: number }
  }
}

describe('runtime service Windows subprocess contract', () => {
  test('starts, authenticates, reconnects, redacts capability secrets, serializes tool mutations, and shuts down cleanly', async () => {
    previousHome = process.env.HOME
    previousUserProfile = process.env.USERPROFILE
    tempRoot = await mkdtemp(join(tmpdir(), 'microcode-runtime-process-'))
    process.env.HOME = tempRoot
    process.env.USERPROFILE = tempRoot

    const cwd = join(tempRoot, 'workspace')
    const projectConfigDir = join(cwd, '.microcode')
    await mkdir(projectConfigDir, { recursive: true })
    await writeFile(join(projectConfigDir, 'config.json'), JSON.stringify({
      mcpServers: {
        redaction_probe: {
          type: 'http',
          url: 'http://127.0.0.1:9/mcp',
          headers: { Authorization: 'Bearer cross-process-capability-secret' },
        },
      },
    }))

    const key = runtimeInstanceKey(cwd)
    const token = await getOrCreateRuntimeToken(key)
    const initial = launchRuntime(cwd, key)
    child = initial.process
    const ready = await waitForReady(key, initial.process, initial.output)
    expect(ready.pid).toBe(initial.process.pid)
    const baseUrl = `http://${ready.hostname}:${ready.port}`
    const client = new RuntimeServiceClient(baseUrl, token)
    expect(await client.handshake()).toEqual({ protocolVersion: ready.protocolVersion })

    const firstSnapshot = await client.getSnapshot<any>(ready.sessionId)
    expect(JSON.stringify(firstSnapshot)).not.toContain('cross-process-capability-secret')

    const controller = new AbortController()
    const eventStream = client.events(ready.sessionId, 0, controller.signal)
    await client.sendCommand(ready.sessionId, 'model.auth.login', { provider_id: 'deepseek', auth_type: 'api_key' })
    const prompt = await nextEventOf(await eventStream[Symbol.asyncIterator](), 'model_auth_prompt')
    expect(prompt.payload.prompt.type).toBe('secret')
    expect(JSON.stringify(prompt)).not.toContain('cross-process-capability-secret')
    await client.sendCommand(ready.sessionId, 'model.auth.prompt.resolve', { request_id: prompt.payload.request_id, cancel: true })
    const completion = await nextEventOf(await eventStream[Symbol.asyncIterator](), 'model_auth_complete')
    expect(completion.payload.success).toBe(false)
    const lastSequence = completion.sequence ?? prompt.sequence ?? 0
    await eventStream.return(undefined as never)

    const reconnected = new RuntimeServiceClient(baseUrl, token)
    expect(await reconnected.handshake()).toEqual({ protocolVersion: ready.protocolVersion })
    const snapshot = await reconnected.getSnapshot<any>(ready.sessionId)
    expect(snapshot.identity.id).toBe(firstSnapshot.identity.id)
    expect(JSON.stringify(snapshot)).not.toContain('cross-process-capability-secret')
    const resumedEvents = reconnected.events(ready.sessionId, lastSequence, AbortSignal.timeout(10_000))
    const resumedIterator = resumedEvents[Symbol.asyncIterator]()

    const toolVersion = snapshot.tools.version as number
    const mutations = await Promise.allSettled([
      reconnected.sendCommand(ready.sessionId, 'tool.set', { tool_id: 'WebFetch', enabled: true, expected_version: toolVersion }),
      reconnected.sendCommand(ready.sessionId, 'tool.set', { tool_id: 'WebSearch', enabled: true, expected_version: toolVersion }),
    ])
    if (mutations.every((result) => result.status === 'rejected')) {
      throw new Error(`Both versioned tool mutations were rejected: ${mutations.map((result) => result.status === 'rejected' ? `${result.reason.status}/${result.reason.code}:${result.reason.message}` : 'ok').join(' | ')}; snapshot=${JSON.stringify(snapshot.tools)}`)
    }
    expect(mutations.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(mutations.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rejected = mutations.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
    expect(rejected.reason).toMatchObject({ code: 'stale_tool_snapshot' })
    await resumedIterator.return(undefined as never)

    await reconnected.shutdown(AbortSignal.timeout(2_000))
    expect(await waitForExit(initial.process, initial.output)).toBe(0)
    expect(await readRuntimeMetadata(key)).toBeUndefined()

    const restarted = launchRuntime(cwd, key)
    child = restarted.process
    const readyAgain = await waitForReady(key, restarted.process, restarted.output)
    expect(readyAgain.pid).toBe(restarted.process.pid)
    expect(readyAgain.pid).not.toBe(ready.pid)
    const restartedClient = new RuntimeServiceClient(`http://${readyAgain.hostname}:${readyAgain.port}`, token)
    expect(await restartedClient.handshake()).toEqual({ protocolVersion: readyAgain.protocolVersion })
    await restartedClient.shutdown(AbortSignal.timeout(2_000))
    expect(await waitForExit(restarted.process, restarted.output)).toBe(0)
    child = undefined
    expect(await readRuntimeMetadata(key)).toBeUndefined()
    expect(initial.output()).not.toContain('cross-process-capability-secret')
    expect(restarted.output()).not.toContain('cross-process-capability-secret')
  })
})

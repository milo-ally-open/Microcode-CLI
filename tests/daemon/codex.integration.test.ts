import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai'
import { getAllModels } from '../../src/models/index.ts'
import { createGatewayServer } from '../../src/daemon/server.ts'
import type { GatewayModelRuntime, GatewayRequestOptions, GatewayServerHandle } from '../../src/daemon/types.ts'

const enabled = process.env.MICROCODE_CODEX_INTEGRATION === '1'
if (enabled) setDefaultTimeout(60_000)
const DUMMY_GATEWAY_TOKEN = 'local-codex-smoke-token'
const expectedText = 'Codex reached the Microcode Model Gateway.'
const expectedCodexVersion = readFileSync(new URL('../fixtures/clients/codex-cli.version.txt', import.meta.url), 'utf8').trim()
// Codex CLI 0.164 emits a hosted `custom` tool in its Responses request. The gateway deliberately
// rejects hosted tools before provider inference; this smoke verifies that boundary end to end.
const catalogModel = getAllModels().find((item) => item.provider === 'openai-codex' && item.id === 'gpt-5.5')!
const model = catalogModel as Model<any>

let testHome: string | undefined
let codexHomePath: string | undefined
let gateway: GatewayServerHandle | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
  if (codexHomePath) await rm(codexHomePath, { recursive: true, force: true })
  codexHomePath = undefined
  if (testHome) await rm(testHome, { recursive: true, force: true })
  testHome = undefined
})

function resultMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: expectedText }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 8, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
  }
}

function runtimeForCodex(
  calls: Array<{ context: Context; options: GatewayRequestOptions }>,
  observedEvents: string[],
  resolvedModels: string[],
  returnToolCall = false,
): GatewayModelRuntime {
  return {
    getModels: () => [model],
    getProviders: () => [],
    checkAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    resolveModel: (id) => {
      resolvedModels.push(id)
      return id === `${model.provider}/${model.id}` || id === model.id ? model : undefined
    },
    async *stream(_selected: Model<any>, context, options) {
      calls.push({ context, options })
      const hasToolResult = context.messages.some((message) => message.role === 'toolResult')
      if (returnToolCall && !hasToolResult) {
        const call = { type: 'toolCall', id: 'call_codex_roundtrip', name: 'exec_command', arguments: { cmd: "printf 'MICROCODE_CODEX_TOOL_ROUNDTRIP'" } } as const
        const message: AssistantMessage = { ...resultMessage(), content: [call], stopReason: 'toolUse' }
        const toolEvents: AssistantMessageEvent[] = [
          { type: 'start', partial: message },
          { type: 'toolcall_start', contentIndex: 0, partial: message },
          { type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message },
          { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message },
          { type: 'done', reason: 'toolUse', message },
        ]
        for (const event of toolEvents) {
          options.signal?.throwIfAborted()
          observedEvents.push(event.type)
          yield event
        }
        return
      }
      const message = resultMessage()
      const events: AssistantMessageEvent[] = [
        { type: 'start', partial: message },
        { type: 'text_start', contentIndex: 0, partial: message },
        { type: 'text_delta', contentIndex: 0, delta: expectedText },
        { type: 'text_end', contentIndex: 0, content: expectedText, partial: message },
        { type: 'done', reason: 'stop', message },
      ]
      for (const event of events) {
        options.signal?.throwIfAborted()
        observedEvents.push(event.type)
        yield event
      }
    },
    async complete(_selected: Model<any>, context, options) {
      calls.push({ context, options })
      options.signal?.throwIfAborted()
      return resultMessage()
    },
  }
}

async function runCodex(args: string[], env: NodeJS.ProcessEnv, prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const executable = process.env.MICROCODE_CODEX_BIN || 'codex'
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: testHome, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.stdin.end(prompt)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

async function runGatewaySmoke(returnToolCall = false) {
  testHome = await mkdtemp(join(tmpdir(), 'microcode-codex-gateway-'))
  const codexHome = codexHomePath = await mkdtemp(join(homedir(), '.microcode-codex-gateway-'))
  const calls: Array<{ context: Context; options: GatewayRequestOptions }> = []
  const observedEvents: string[] = []
  const resolvedModels: string[] = []
  gateway = createGatewayServer({
    token: DUMMY_GATEWAY_TOKEN,
    rpcToken: 'internal-test-token',
    runtime: runtimeForCodex(calls, observedEvents, resolvedModels, returnToolCall),
    port: 0,
  })
  const baseUrl = `http://${gateway.hostname}:${gateway.port}/v1`
  await writeFile(join(codexHome, 'config.toml'), [
    `model = "${model.provider}/${model.id}"`,
    'model_provider = "microcode"',
    'sandbox_mode = "read-only"',
    '[model_providers.microcode]',
    'name = "Microcode Gateway Integration Test"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'env_key = "MICROCODE_CODEX_SMOKE_TOKEN"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
  ].join('\n'), { mode: 0o600 })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: testHome,
    CODEX_HOME: codexHome,
    TERM: 'dumb',
    MICROCODE_CODEX_SMOKE_TOKEN: DUMMY_GATEWAY_TOKEN,
    CODEX_DISABLE_UPDATE_CHECK: '1',
  }
  const result = await runCodex([
    'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json', '-',
  ], env, 'Reply with the exact text the test server sends.')
  return { result, calls, observedEvents, resolvedModels }
}

describe('installed Codex CLI gateway smoke', () => {
  if (!enabled) {
    test.skip('set MICROCODE_CODEX_INTEGRATION=1 to run against the installed Codex CLI', () => {})
    return
  }

  test('runs the pinned Codex CLI version recorded by the smoke fixture', () => {
    const executable = process.env.MICROCODE_CODEX_BIN || 'codex'
    const version = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_DISABLE_UPDATE_CHECK: '1' },
    })
    if (version.error) throw version.error
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe(expectedCodexVersion)
  })

  test('reaches the gateway and safely rejects Codex hosted tools', async () => {
    const { result, calls, resolvedModels } = await runGatewaySmoke()

    expect(result.code).not.toBe(0)
    expect(result.stdout).toContain('Unsupported Responses tool type')
    expect(result.stdout).toContain('custom')
    expect(result.stdout + result.stderr).not.toContain(DUMMY_GATEWAY_TOKEN)
    expect(resolvedModels).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})

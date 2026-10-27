import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Models } from '@earendil-works/pi-ai'
import { getAllModels, getModelConfigDiagnostics } from '../../src/models/index.ts'
import { completePiModel, createPiGatewayRuntime, streamPiModel } from '../../src/daemon/runtime.ts'

async function writeProjectModel(cwd: string, name: string, baseUrl: string) {
  await mkdir(join(cwd, '.microcode'), { recursive: true })
  await writeFile(join(cwd, '.microcode', 'config.json'), JSON.stringify({
    models: [{
      id: 'project-model',
      name,
      api: 'openai-completions',
      baseUrl,
      contextWindow: 16_000,
      maxTokens: 2_000,
    }],
  }))
}

describe('Pi gateway runtime', () => {
  test('requests Responses summaries through Pi API-specific options, preserving the Simple path otherwise', async () => {
    const baseModel = getAllModels().find((entry) => entry.provider === 'deepseek' && entry.id === 'deepseek-v4-pro')!
    const responsesModel = { ...baseModel, api: 'openai-responses' } as Model<any>
    const calls: Array<{ method: string; options: Record<string, unknown> }> = []
    const emptyStream = async function* (): AsyncGenerator<AssistantMessageEvent> {}
    const collection = {
      stream(_model: Model<any>, _context: Context, options: Record<string, unknown>) {
        calls.push({ method: 'stream', options })
        return emptyStream()
      },
      streamSimple(_model: Model<any>, _context: Context, options: Record<string, unknown>) {
        calls.push({ method: 'streamSimple', options })
        return emptyStream()
      },
      async complete(_model: Model<any>, _context: Context, options: Record<string, unknown>) {
        calls.push({ method: 'complete', options })
        return {} as AssistantMessage
      },
      async completeSimple(_model: Model<any>, _context: Context, options: Record<string, unknown>) {
        calls.push({ method: 'completeSimple', options })
        return {} as AssistantMessage
      },
    } as unknown as Models
    const context: Context = { messages: [] }

    streamPiModel(collection, responsesModel, context, { reasoning: 'low', reasoningSummary: 'auto' })
    await completePiModel(collection, responsesModel, context, { reasoning: 'high', reasoningSummary: 'detailed' })
    streamPiModel(collection, { ...responsesModel, api: 'openai-completions' } as Model<any>, context, { reasoning: 'low' })

    expect(calls.map((call) => call.method)).toEqual(['stream', 'complete', 'streamSimple'])
    expect(calls[0]?.options).toMatchObject({ reasoningEffort: 'low', reasoningSummary: 'auto' })
    expect(calls[1]?.options).toMatchObject({ reasoningEffort: 'high', reasoningSummary: 'detailed' })
    expect(calls[2]?.options).toMatchObject({ reasoning: 'low' })
  })

  test('retains but does not expose project custom models through the gateway', async () => {
    const firstCwd = await mkdtemp(join(tmpdir(), 'microcode-gateway-project-a-'))
    const secondCwd = await mkdtemp(join(tmpdir(), 'microcode-gateway-project-b-'))
    try {
      await writeProjectModel(firstCwd, 'Project A Model', 'http://127.0.0.1:11434/v1')
      await writeProjectModel(secondCwd, 'Project B Model', 'http://127.0.0.1:11435/v1')
      const runtime = createPiGatewayRuntime()

      const firstCustom = await runtime.resolveModel('custom:project-model/project-model', firstCwd)
      const secondCustom = await runtime.resolveModel('custom:project-model/project-model', secondCwd)
      const firstAllowed = await runtime.resolveModel('deepseek/deepseek-v4-pro', firstCwd)
      const secondAllowed = await runtime.resolveModel('deepseek/deepseek-v4-pro', secondCwd)

      expect(firstCustom).toBeUndefined()
      expect(secondCustom).toBeUndefined()
      expect(firstAllowed?.provider).toBe('deepseek')
      expect(secondAllowed?.provider).toBe('deepseek')
      expect(firstAllowed).toEqual(secondAllowed)
      expect(getModelConfigDiagnostics(firstCwd)).toHaveLength(1)
      expect(getAllModels().some((model) => model.id === 'project-model')).toBe(false)
    } finally {
      await Promise.all([
        rm(firstCwd, { recursive: true, force: true }),
        rm(secondCwd, { recursive: true, force: true }),
      ])
    }
  })
})

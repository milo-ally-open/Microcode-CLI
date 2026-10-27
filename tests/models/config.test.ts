import { describe, expect, test } from 'bun:test'
import { customModelToModel, loadCustomModels, type CustomModelDef } from '../../src/models/custom.ts'
import {
  createModelsForCwd,
  findModel,
  getAllModels,
  getModelCatalog,
  getModelConfig,
  getModelConfigDiagnostics,
  getModels,
  resolveApiKey,
  setCurrentModel,
} from '../../src/models/registry.ts'

describe('models and config modules', () => {
  test('exposes only the approved upstream provider models', () => {
    const modelIds = getAllModels().map((model) => model.id)
    const providerIds = getModels().getProviders().map((provider) => provider.id).sort()

    expect(modelIds).toContain('deepseek-v4-pro')
    expect(providerIds).toEqual(['deepseek', 'openai', 'openai-codex'])
    expect(modelIds.some((id) => id.startsWith('gemini-'))).toBe(false)
  })

  test('exposes a Pi-free catalog without endpoint overrides or credentials', () => {
    const catalog = getModelCatalog()
    expect(catalog.providers.map((provider) => provider.id)).toEqual(['openai-codex', 'openai', 'deepseek'])
    expect(catalog.providers[1]).toMatchObject({
      name: 'OpenAI GPT',
      adapterVersion: 1,
      authModes: ['api_key'],
      supportedApis: ['openai-responses'],
    })
    expect(catalog.models.some((model) => model.id === 'deepseek/deepseek-v4-pro')).toBe(true)
    expect(JSON.stringify(catalog)).not.toContain('baseUrl')
    expect(JSON.stringify(catalog)).not.toContain('OPENAI_API_KEY')
  })

  test('resolves models by provider and qualified model id', () => {
    const deepseek = findModel('deepseek-v4-pro', undefined, 'deepseek')
    const qualified = findModel('deepseek/deepseek-v4-pro')

    expect(deepseek?.provider).toBe('deepseek')
    expect(qualified?.provider).toBe('deepseek')
    expect(deepseek?.api).toBe('openai-completions')
  })

  test('preserves supported endpoint overrides without extending the provider allowlist', () => {
    const previousGlobalBase = process.env.BASE_URL
    const previousOpenAiBase = process.env.OPENAI_BASE_URL
    try {
      delete process.env.BASE_URL
      process.env.OPENAI_BASE_URL = 'https://example.test/v1'

      expect(findModel('deepseek-v4-pro', undefined, 'deepseek')?.baseUrl).toBe('https://example.test/v1')
      const openAiModel = getAllModels().find((model) => model.provider === 'openai')
      expect(openAiModel).toBeDefined()
      expect(findModel(openAiModel!.id, undefined, 'openai')?.baseUrl).toBe('https://example.test/v1')
      expect(findModel('gemini-2.5-flash')).toBeUndefined()
    } finally {
      if (previousGlobalBase === undefined) delete process.env.BASE_URL
      else process.env.BASE_URL = previousGlobalBase
      if (previousOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previousOpenAiBase
    }
  })

  test('rejects a model selection outside the enabled provider catalog', () => {
    expect(() => getModelConfig('gemini-2.5-flash')).toThrow('not enabled or was not found')
  })

  test('setCurrentModel accepts an enabled model', () => {
    const selectedModel = findModel('deepseek-v4-pro', undefined, 'deepseek')
    expect(selectedModel).toBeDefined()
    setCurrentModel(selectedModel!)
    expect(getModelConfig().model.provider).toBe('deepseek')
  })

  test('legacy custom model conversion does not make arbitrary API keys available', () => {
    const def: CustomModelDef = {
      id: 'local-test',
      name: 'Local Test',
      api: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyEnv: 'LOCAL_TEST_KEY',
      reasoning: true,
      thinkingFormat: 'deepseek',
      input: ['text', 'image'],
      contextWindow: 8192,
      maxTokens: 2048,
    }
    process.env.LOCAL_TEST_KEY = 'secret'
    const model = customModelToModel(def)

    expect(model.provider).toBe('custom')
    expect(model.input).toEqual(['text', 'image'])
    expect(model.compat?.thinkingFormat).toBe('deepseek')
    expect(resolveApiKey(model)).toBeUndefined()
    delete process.env.LOCAL_TEST_KEY
  })

  test('retains project custom model config but does not register or call it', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const cwd = await mkdtemp(join(tmpdir(), 'microcode-models-'))
    try {
      await mkdir(join(cwd, '.microcode'), { recursive: true })
      await writeFile(join(cwd, '.microcode', 'config.json'), JSON.stringify({
        models: [
          {
            id: 'project-model',
            name: 'Project Model',
            api: 'openai-completions',
            baseUrl: 'http://localhost/v1',
            apiKeyEnv: 'MIGRATION_TEST_KEY',
            headers: { Authorization: 'Bearer migration-secret' },
            contextWindow: 128000,
            maxTokens: 4096,
          },
          { id: 'invalid' },
        ],
      }))

      expect(loadCustomModels(cwd).map((model) => model.id)).toEqual(['project-model'])
      const diagnostics = getModelConfigDiagnostics(cwd)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toContain('custom/project-model')
      expect(diagnostics[0]).not.toContain('baseUrl')
      expect(diagnostics[0]).not.toContain('MIGRATION_TEST_KEY')
      expect(diagnostics[0]).not.toContain('migration-secret')
      expect(createModelsForCwd(cwd).allModels.some((model) => model.id === 'project-model')).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('the Codex provider has subscription OAuth and no API-key login', () => {
    const codex = getModels().getProvider('openai-codex')

    expect(codex?.auth.oauth?.isSubscription).toBe(true)
    expect(codex?.auth.oauth?.name).toContain('ChatGPT Plus/Pro')
    expect(codex?.auth.apiKey).toBeUndefined()
    expect(typeof codex?.auth.oauth?.refresh).toBe('function')
    expect(getAllModels().some((model) => model.provider === 'openai-codex')).toBe(true)
  })
})

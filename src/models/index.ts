import type { Api, Model } from '@earendil-works/pi-ai'

export {
  getAllModels,
  getModelCatalog,
  createModelsForCwd,
  getModelConfigDiagnostics,
  getConfiguredModel,
  getCurrentModel,
  setCurrentModel,
  findModel,
  resolveApiKey,
  getModelConfig,
  getModels,
  getCustomModelDefs,
  type ModelConfig,
} from './registry.ts'

export type { ModelCatalogSnapshot, ModelDescriptor, ModelProviderDescriptor } from './contracts.ts'
export type { ModelAuthChoice, ModelAuthEvent, ModelAuthInteraction, ModelAuthPrompt, ModelAuthProviderDescriptor, ModelAuthStatus, ModelAuthType } from './contracts.ts'

export { getModelAuthProviders, getModelAuthStatus, loginModelProvider, logoutModelProvider } from './authFacade.ts'

export {
  loadCustomModels,
  getUnsupportedCustomModelDiagnostics,
  customModelToModel,
  type CustomModelDef,
  type CustomModelsConfig,
} from './custom.ts'

export function modelSupportsImages(model: Model<Api>): boolean {
  return model.input.includes('image')
}

export { EncryptedCredentialStore } from './EncryptedCredentialStore.ts'

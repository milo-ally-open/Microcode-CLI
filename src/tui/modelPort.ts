import type { RuntimeModelDescriptor } from '../runtime/contracts.ts'
import type { ModelAuthInteraction, ModelAuthProviderDescriptor, ModelAuthStatus, ModelAuthType, ModelCatalogSnapshot } from '../models/contracts.ts'

export interface TuiModelSwitchSnapshot {
  readonly model: RuntimeModelDescriptor
  readonly provider: string
  readonly apiKeyConfigured: boolean
  readonly thinkingLevel: string
}

export interface TuiModelPort {
  getCatalog(): ModelCatalogSnapshot | Promise<ModelCatalogSnapshot>
  switchModel(modelId: string, api?: string, provider?: string): TuiModelSwitchSnapshot | Promise<TuiModelSwitchSnapshot>
  suggestSessionTitle(openingSentence: string): Promise<string>
  listProviders(): Promise<readonly ModelAuthProviderDescriptor[]>
  getAuthStatus(): Promise<readonly ModelAuthStatus[]>
  login(providerId: string, authType: ModelAuthType, interaction: ModelAuthInteraction): Promise<void>
  logout(providerId: string): Promise<void>
  dispose?(): void | Promise<void>
}

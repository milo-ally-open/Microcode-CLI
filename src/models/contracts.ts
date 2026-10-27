/** Pi-free model catalog contracts for runtime and client boundaries. */
export interface ModelDescriptor {
  readonly id: string
  readonly providerId: string
  readonly modelId: string
  readonly apiId: string
  readonly name: string
  readonly input: readonly string[]
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly reasoning: boolean
}

export interface ModelProviderDescriptor {
  readonly id: string
  readonly name: string
  readonly adapterVersion: number
  readonly authModes: readonly string[]
  readonly supportedApis: readonly string[]
  readonly models: readonly ModelDescriptor[]
}

export interface ModelCatalogSnapshot {
  readonly providers: readonly ModelProviderDescriptor[]
  readonly models: readonly ModelDescriptor[]
}

export type ModelAuthType = 'oauth' | 'api_key'

export interface ModelAuthChoice {
  readonly value: ModelAuthType
  readonly label: string
  readonly description: string
}

export interface ModelAuthProviderDescriptor {
  readonly id: string
  readonly name: string
  readonly authChoices: readonly ModelAuthChoice[]
}

export interface ModelAuthStatus {
  readonly providerId: string
  readonly configured: boolean
  readonly type?: ModelAuthType
  readonly error?: boolean
}

export type ModelAuthPrompt =
  | { readonly type: 'text'; readonly message: string; readonly placeholder?: string; readonly signal?: AbortSignal }
  | { readonly type: 'secret'; readonly message: string; readonly placeholder?: string; readonly signal?: AbortSignal }
  | { readonly type: 'manual_code'; readonly message: string; readonly placeholder?: string; readonly signal?: AbortSignal }
  | { readonly type: 'select'; readonly message: string; readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[]; readonly signal?: AbortSignal }

export type ModelAuthEvent =
  | { readonly type: 'info'; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
  | { readonly type: 'auth_url'; readonly url: string; readonly instructions?: string }
  | { readonly type: 'device_code'; readonly userCode: string; readonly verificationUri: string; readonly intervalSeconds?: number; readonly expiresInSeconds?: number }
  | { readonly type: 'progress'; readonly message: string }

export interface ModelAuthInteraction {
  readonly signal: AbortSignal
  prompt(prompt: ModelAuthPrompt): Promise<string>
  notify(event: ModelAuthEvent): void
}

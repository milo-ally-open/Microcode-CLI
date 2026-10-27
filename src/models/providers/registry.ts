import type { Api, AuthType, Provider } from '@earendil-works/pi-ai'
import type { ModelProviderAdapter } from './types.ts'

const SUPPORTED_UPSTREAM_APIS = new Set<Api>([
  'openai-codex-responses',
  'openai-responses',
  'openai-completions',
])

function providerAuthModes(provider: Provider): AuthType[] {
  const modes: AuthType[] = []
  if (provider.auth.oauth) modes.push('oauth')
  if (provider.auth.apiKey?.login) modes.push('api_key')
  return modes
}

export function createModelProviders(registrations: readonly ModelProviderAdapter[]): Provider[] {
  const seen = new Set<string>()
  return registrations.map((registration) => {
    if (seen.has(registration.id)) throw new Error('Duplicate model provider registration: ' + registration.id)
    seen.add(registration.id)
    if (!registration.name.trim()) throw new Error('Model provider must declare a display name: ' + registration.id)
    if (!Number.isInteger(registration.version) || registration.version < 1) {
      throw new Error('Model provider adapter version must be a positive integer: ' + registration.id)
    }
    if (registration.authModes.length === 0) throw new Error('Model provider must declare an auth mode: ' + registration.id)
    if (new Set(registration.authModes).size !== registration.authModes.length) {
      throw new Error('Duplicate auth mode in model provider registration: ' + registration.id)
    }
    if (registration.supportedApis.length === 0) throw new Error('Model provider must declare a supported API: ' + registration.id)

    const provider = registration.createPiProvider()
    if (provider.id !== registration.id) {
      throw new Error('Model provider registration ID does not match provider factory: ' + registration.id)
    }
    const actualAuthModes = providerAuthModes(provider).sort()
    const declaredAuthModes = [...registration.authModes].sort()
    if (JSON.stringify(actualAuthModes) !== JSON.stringify(declaredAuthModes)) {
      throw new Error('Model provider auth declaration does not match provider factory: ' + registration.id)
    }
    const catalog = provider.getModels()
    if (catalog.length === 0) throw new Error('Model provider catalog must not be empty: ' + registration.id)
    for (const model of catalog) {
      if (!SUPPORTED_UPSTREAM_APIS.has(model.api) || !registration.supportedApis.includes(model.api)) {
        throw new Error('Unsupported upstream API "' + model.api + '" in model provider: ' + registration.id)
      }
      if (model.provider !== registration.id) {
        throw new Error('Model provider catalog contains a model with a different provider ID: ' + registration.id)
      }
    }
    return provider
  })
}

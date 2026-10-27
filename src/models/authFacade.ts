import type { AuthType, Models } from '@earendil-works/pi-ai'
import { getModels } from './registry.ts'
import { getProviderAuthChoices } from './authChoices.ts'
import type { ModelAuthEvent, ModelAuthInteraction, ModelAuthProviderDescriptor, ModelAuthStatus, ModelAuthType } from './contracts.ts'

function authModels(models?: Models): Models {
  return models ?? getModels()
}

export function getModelAuthProviders(models?: Models): readonly ModelAuthProviderDescriptor[] {
  return Object.freeze(authModels(models).getProviders().map((provider) => Object.freeze({
    id: provider.id,
    name: provider.name,
    authChoices: Object.freeze(getProviderAuthChoices(provider).map((choice) => Object.freeze({ ...choice }))),
  })))
}

export async function getModelAuthStatus(signal?: AbortSignal, models?: Models): Promise<readonly ModelAuthStatus[]> {
  const collection = authModels(models)
  return Object.freeze(await Promise.all(collection.getProviders().map(async (provider) => {
    try {
      const auth = await collection.checkAuth(provider.id, { signal })
      return Object.freeze({
        providerId: provider.id,
        configured: Boolean(auth),
        ...(auth ? { type: auth.type } : {}),
      })
    } catch {
      return Object.freeze({ providerId: provider.id, configured: false, error: true })
    }
  })))
}

export async function loginModelProvider(
  providerId: string,
  authType: ModelAuthType,
  interaction: ModelAuthInteraction,
  models?: Models,
): Promise<void> {
  const collection = authModels(models)
  const provider = collection.getProvider(providerId)
  if (!provider) throw new Error('Unknown auth provider.')
  const supported = getProviderAuthChoices(provider).some((choice) => choice.value === authType)
  if (!supported) throw new Error('Provider does not support the requested sign-in method.')
  await collection.login(providerId, authType as AuthType, {
    signal: interaction.signal,
    prompt: (prompt) => interaction.prompt(prompt),
    notify: (event) => interaction.notify(event as ModelAuthEvent),
  })
}

export async function logoutModelProvider(providerId: string, signal?: AbortSignal, models?: Models): Promise<void> {
  const collection = authModels(models)
  if (!collection.getProvider(providerId)) throw new Error('Unknown auth provider.')
  await collection.logout(providerId, { signal })
}

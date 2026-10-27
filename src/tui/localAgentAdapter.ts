import type { PiMicrocodeAgent } from '../agent/index.ts'
import type { Api } from '@earendil-works/pi-ai'
import { getModelAuthProviders, getModelAuthStatus, getModelCatalog, loginModelProvider, logoutModelProvider } from '../models/index.ts'
import type { ModelAuthInteraction, ModelAuthType } from '../models/contracts.ts'
import { toRuntimeMessage, toRuntimeModel } from '../kernel/pi/mapper.ts'
import { toRuntimeAgentEvent } from '../agent/runtimeProjection.ts'
import { toTuiAgentEvent, type TuiAgentEventListener, type TuiAgentPort, type TuiImageInput, type TuiThinkingLevel } from './agentPort.ts'
import type { TuiModelPort } from './modelPort.ts'

/**
 * Keep the explicitly in-process fallback behind the same event projection as
 * the Bun runtime client. Other Agent methods are forwarded with the original
 * receiver so its internal state remains owned by MicrocodeAgent.
 */
export function adaptLocalAgentForTui(agent: PiMicrocodeAgent): TuiAgentPort {
  return new Proxy(agent as unknown as TuiAgentPort, {
    get(_target, property) {
      if (property === 'getSnapshot') {
        return () => {
          const snapshot = agent.getSnapshot()
          const tokens = agent.getTokenStats()
          return {
            cwd: snapshot.cwd,
            model: snapshot.model,
            thinkingLevel: snapshot.thinkingLevel,
            tokens: { context: tokens.context, session: tokens.session },
          }
        }
      }
      if (property === 'getCurrentModel') {
        return () => toRuntimeModel(agent.getCurrentModel())
      }
      if (property === 'prompt') {
        return (input: string, images?: readonly TuiImageInput[]) => agent.prompt(input, images ? [...images] : undefined)
      }
      if (property === 'setThinkingLevel') {
        return (level: TuiThinkingLevel) => agent.setThinkingLevel(level)
      }
      if (property === 'getMessages') {
        return () => agent.getMessages().map(toRuntimeMessage)
      }
      if (property === 'subscribe') {
        return (listener: TuiAgentEventListener) => agent.subscribe((event, signal) => {
          const projected = toTuiAgentEvent(toRuntimeAgentEvent(event, toRuntimeMessage))
          if (projected) return listener(projected, signal)
        })
      }
      const value = Reflect.get(agent, property, agent) as unknown
      return typeof value === 'function' ? value.bind(agent) : value
    },
  })
}

/** Local model adapter used only by the explicit --no-daemon path. */
export function adaptLocalModelForTui(agent: PiMicrocodeAgent): TuiModelPort {
  return {
    getCatalog: () => getModelCatalog(),
    switchModel: (modelId, api, provider) => {
      const snapshot = agent.switchModel(modelId, api as Api | undefined, provider)
      return {
        model: snapshot.model,
        provider: snapshot.provider,
        apiKeyConfigured: snapshot.apiKeyConfigured,
        thinkingLevel: snapshot.thinkingLevel,
      }
    },
    suggestSessionTitle: (openingSentence) => agent.suggestSessionTitle(openingSentence),
    listProviders: async () => getModelAuthProviders(),
    getAuthStatus: () => getModelAuthStatus(),
    login: (providerId: string, authType: ModelAuthType, interaction: ModelAuthInteraction) => loginModelProvider(providerId, authType, interaction),
    logout: (providerId: string) => logoutModelProvider(providerId),
  }
}

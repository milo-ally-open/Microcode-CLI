import type { Api, AuthType, Provider } from '@earendil-works/pi-ai'

/** A statically linked, reviewed adapter contribution. */
export interface ModelProviderAdapter {
  readonly id: string
  readonly name: string
  /** Adapter contract revision, independent of the pinned Pi dependency version. */
  readonly version: number
  readonly authModes: readonly AuthType[]
  readonly supportedApis: readonly Api[]
  /** Pi-specific construction is contained within this adapter boundary. */
  readonly createPiProvider: () => Provider
}

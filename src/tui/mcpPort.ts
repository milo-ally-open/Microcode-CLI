export interface TuiMcpServerState {
  readonly name: string
  readonly status: string
  readonly tools: readonly string[]
  readonly resources: readonly string[]
  readonly toolCount: number
  readonly resourceCount: number
  readonly summary: string
  readonly error?: string
}

export interface TuiMcpConfiguredServer {
  readonly name: string
  readonly scope: string
  readonly packageName?: string
  readonly sourcePath?: string
  readonly summary: string
}

export interface TuiMcpSnapshot {
  readonly servers: readonly TuiMcpServerState[]
  readonly configuredServers: readonly TuiMcpConfiguredServer[]
  readonly diagnostics: readonly string[]
}

/** MCP operations presented to the UI, independent of the connection/runtime implementation. */
export interface TuiMcpPort {
  refresh(): Promise<TuiMcpSnapshot>
  getReadyStates?(): readonly Pick<TuiMcpServerState, 'name' | 'status'>[]
  applyPending?(): void
}

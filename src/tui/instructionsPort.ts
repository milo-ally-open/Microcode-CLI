export interface TuiProjectInstructionFile {
  readonly path: string
  readonly content: string
  readonly bytes: number
  readonly truncated: boolean
}

export interface TuiProjectInstructions {
  readonly projectRoot: string
  readonly workingDirectory: string
  readonly files: readonly TuiProjectInstructionFile[]
  readonly diagnostics: readonly string[]
  readonly totalBytes: number
}

export interface TuiInitProposal {
  readonly revision: string
  readonly path: string
  readonly currentContent: string
  readonly proposal?: string
  readonly maxBytes: number
}

/** Project instruction workflows exposed to the UI as explicit runtime operations. */
export interface TuiInstructionsPort {
  prepareInit(): Promise<TuiInitProposal>
  applyInit(revision: string, proposal: string): Promise<TuiProjectInstructions>
  reload(): Promise<TuiProjectInstructions>
}

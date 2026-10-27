export interface TuiGitFileChange {
  readonly path: string
  readonly indexStatus: string
  readonly worktreeStatus: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
}

export interface TuiGitStatus {
  readonly root: string
  readonly branch: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly changes: readonly TuiGitFileChange[]
}

export interface TuiGitBranch {
  readonly name: string
  readonly current: boolean
}

export interface TuiGitRepository {
  readonly root: string
  status(): Promise<TuiGitStatus>
  branches(): Promise<TuiGitBranch[]>
  diff(staged?: boolean, paths?: string[]): Promise<string>
  history(limit?: number): Promise<string[]>
  stage(paths: string[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  discard(paths: string[]): Promise<void>
  commit(message: string): Promise<string>
  switchBranch(name: string): Promise<void>
  createBranch(name: string): Promise<void>
  deleteBranch(name: string): Promise<void>
  fetch(): Promise<void>
  pull(): Promise<void>
  push(): Promise<void>
  stashPush(message?: string): Promise<void>
  stashList(): Promise<string[]>
  stashApply(ref: string, pop?: boolean): Promise<void>
}

/** Client contract for the independently managed Git capability. */
export interface TuiGitPort {
  open(): Promise<TuiGitRepository>
}

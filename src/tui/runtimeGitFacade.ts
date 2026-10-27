import type { RuntimeClientSession } from '../runtime/client.ts'
import type { TuiGitPort, TuiGitRepository, TuiGitStatus, TuiGitBranch } from './gitPort.ts'

/** Git capability facade; repository access stays in the Bun runtime process. */
export class RuntimeTuiGitPort implements TuiGitPort {
  constructor(private readonly session: RuntimeClientSession) {}

  async open(): Promise<TuiGitRepository> {
    const status = await this.session.sendCommand<TuiGitStatus>('git.status')
    return new RuntimeTuiGitRepository(this.session, status.root)
  }
}

class RuntimeTuiGitRepository implements TuiGitRepository {
  constructor(
    private readonly session: RuntimeClientSession,
    readonly root: string,
  ) {}

  status(): Promise<TuiGitStatus> { return this.session.sendCommand('git.status') }
  branches(): Promise<TuiGitBranch[]> { return this.session.sendCommand('git.branches') }
  diff(staged = false, paths: string[] = []): Promise<string> {
    return this.session.sendCommand('git.diff', { staged, paths })
  }
  history(limit = 20): Promise<string[]> { return this.session.sendCommand('git.history', { limit }) }
  stage(paths: string[]): Promise<void> { return this.session.sendCommand('git.stage', { paths }) }
  unstage(paths: string[]): Promise<void> { return this.session.sendCommand('git.unstage', { paths }) }
  discard(paths: string[]): Promise<void> { return this.session.sendCommand('git.discard', { paths }) }
  async commit(message: string): Promise<string> {
    const result = await this.session.sendCommand<{ commit: string }>('git.commit', { message })
    return result.commit
  }
  switchBranch(name: string): Promise<void> { return this.session.sendCommand('git.branch.switch', { name }) }
  createBranch(name: string): Promise<void> { return this.session.sendCommand('git.branch.create', { name }) }
  deleteBranch(name: string): Promise<void> { return this.session.sendCommand('git.branch.delete', { name }) }
  fetch(): Promise<void> { return this.session.sendCommand('git.fetch') }
  pull(): Promise<void> { return this.session.sendCommand('git.pull') }
  push(): Promise<void> { return this.session.sendCommand('git.push') }
  stashPush(message?: string): Promise<void> {
    return this.session.sendCommand('git.stash.push', message === undefined ? {} : { message })
  }
  stashList(): Promise<string[]> { return this.session.sendCommand('git.stash.list') }
  stashApply(ref: string, pop = false): Promise<void> {
    return this.session.sendCommand('git.stash.apply', { ref, pop })
  }
}

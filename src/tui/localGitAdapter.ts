import { GitRepository } from '../git/GitRepository.ts'
import type { TuiGitPort, TuiGitRepository } from './gitPort.ts'

/** Explicit in-process Git implementation used only by --no-daemon. */
export class LocalTuiGitPort implements TuiGitPort {
  constructor(private readonly cwd: string) {}

  async open(): Promise<TuiGitRepository> {
    return GitRepository.open(this.cwd)
  }
}

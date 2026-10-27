import type { RuntimeClientSession } from '../runtime/client.ts'
import type { TuiAgentPort } from './agentPort.ts'
import type { TuiInitProposal, TuiInstructionsPort, TuiProjectInstructions } from './instructionsPort.ts'

/** Instruction file operations remain in the Bun runtime for the regular CLI path. */
export class RuntimeTuiInstructionsFacade implements TuiInstructionsPort {
  constructor(
    private readonly session: RuntimeClientSession,
    private readonly agent: Pick<TuiAgentPort, 'getProjectInstructions'>,
  ) {}

  async prepareInit(): Promise<TuiInitProposal> {
    const result = await this.session.sendCommand<{
      revision: string
      path: string
      current_content: string
      proposal?: string
      max_bytes: number
    }>('instructions.init.propose')
    return {
      revision: result.revision,
      path: result.path,
      currentContent: result.current_content,
      ...(result.proposal === undefined ? {} : { proposal: result.proposal }),
      maxBytes: result.max_bytes,
    }
  }

  async applyInit(revision: string, proposal: string): Promise<TuiProjectInstructions> {
    await this.session.sendCommand('instructions.init.apply', { revision, proposal })
    return this.requireInstructions()
  }

  async reload(): Promise<TuiProjectInstructions> {
    await this.session.sendCommand('instructions.reload')
    return this.requireInstructions()
  }

  private requireInstructions(): TuiProjectInstructions {
    const instructions = this.agent.getProjectInstructions()
    if (!instructions) throw new Error('Runtime project instructions are unavailable.')
    return instructions
  }
}

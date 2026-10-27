import { randomUUID } from 'node:crypto'
import type { PiMicrocodeAgent } from '../agent/index.ts'
import { buildInitTaskPrompt, extractInitDraft, getInitProjectFileOutline } from '../instructions/initProjectGuidance.ts'
import { DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES, loadProjectInstructions, type ProjectInstructions } from '../instructions/projectInstructions.ts'
import { readMicroFile, writeMicroFile, type MicroFileSnapshot } from '../instructions/writeMicroFile.ts'
import type { TuiInitProposal, TuiInstructionsPort, TuiProjectInstructions } from './instructionsPort.ts'

/** Explicit in-process implementation used only by --no-daemon. */
export class LocalTuiInstructionsPort implements TuiInstructionsPort {
  private readonly pending = new Map<string, MicroFileSnapshot>()

  constructor(private readonly agent: PiMicrocodeAgent, private readonly cwd: string) {}

  async prepareInit(): Promise<TuiInitProposal> {
    const before = await readMicroFile(this.cwd)
    const outline = await getInitProjectFileOutline(this.cwd)
    const messageCount = this.agent.getMessages().length
    await this.agent.promptReadOnly(buildInitTaskPrompt(this.cwd, outline))
    const response = [...this.agent.getMessages()].slice(messageCount).reverse()
      .find((message) => message.role === 'assistant')
      ?.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? ''
    const proposal = extractInitDraft(response)
    const revision = randomUUID()
    if (proposal !== undefined) this.pending.set(revision, before)
    return {
      revision,
      path: before.path,
      currentContent: before.content ?? '',
      ...(proposal === undefined ? {} : { proposal }),
      maxBytes: DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES,
    }
  }

  async applyInit(revision: string, proposal: string): Promise<TuiProjectInstructions> {
    const before = this.pending.get(revision)
    if (!before) throw new Error('The MICRO.md proposal expired. Run /init again.')
    if (Buffer.byteLength(proposal, 'utf8') > DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES) {
      throw new Error(`The MICRO.md proposal exceeds the ${DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES}-byte project instruction limit.`)
    }
    this.pending.delete(revision)
    const currentInstructions = await loadProjectInstructions(this.cwd)
    const otherInstructionBytes = currentInstructions.files
      .filter((file) => file.path !== before.path)
      .reduce((total, file) => total + file.bytes, 0)
    if (otherInstructionBytes + Buffer.byteLength(proposal, 'utf8') > DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES) {
      throw new Error('The proposal does not fit in the remaining project instruction budget. Shorten existing instruction files or ask for a shorter MICRO.md proposal.')
    }

    await writeMicroFile(this.cwd, before, proposal)
    const instructions = await loadProjectInstructions(this.cwd)
    await this.agent.updateProjectInstructions(instructions)
    const loadedFile = instructions.files.find((file) => file.path === before.path)
    if (!loadedFile || loadedFile.truncated || loadedFile.content !== proposal) {
      throw new Error(`MICRO.md was saved, but the complete file could not be loaded within the ${DEFAULT_PROJECT_INSTRUCTIONS_MAX_BYTES}-byte combined instruction limit.`)
    }
    return toTuiProjectInstructions(instructions)
  }

  async reload(): Promise<TuiProjectInstructions> {
    const instructions = await loadProjectInstructions(this.cwd)
    await this.agent.updateProjectInstructions(instructions)
    return toTuiProjectInstructions(instructions)
  }
}

export function toTuiProjectInstructions(instructions: ProjectInstructions): TuiProjectInstructions {
  return {
    projectRoot: instructions.projectRoot,
    workingDirectory: instructions.workingDirectory,
    files: instructions.files.map((file) => ({ ...file })),
    diagnostics: [...instructions.diagnostics],
    totalBytes: instructions.totalBytes,
  }
}

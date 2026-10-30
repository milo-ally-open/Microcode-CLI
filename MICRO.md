# Project guidance

## Purpose

Microcode is a terminal-native AI coding assistant for understanding and changing code. It is a single-Agent TypeScript/Bun CLI and TUI, with tools for file operations, shell execution, search, sessions, and Git worktrees.

## Layout and entry points

- `src/entry.ts` — executable entry point; starts the CLI/TUI.
- `src/agent/` — Agent setup, orchestration, and runtime integration; `MicrocodeAgent.ts` is the central implementation.
- `src/kernel/` — kernel contracts and Pi adapters.
- `src/daemon/` and `src/runtime/` — daemon, runtime service, protocol adapters, and runtime client.
- `src/tui/` — terminal UI and runtime-facing adapters.
- `src/tools/`, `src/models/`, `src/permissions/`, `src/session/` — tools, model integration, permissions, and session persistence.
- `src/mcp/`, `src/plugins/`, `src/skill/` — capability integrations.
- `docs/specs/` — product and architecture specifications. For runtime/model integration, consult `docs/specs/runtime-architecture/spec.md` and `docs/specs/model_intergration_spec.md`.
- `tests/` — unit and integration tests, organized by feature.

## Commands

Use Bun versions declared in `package.json` (`bun@1.3.14`).

- `bun run dev` — run `src/entry.ts`.
- `bun run build` — build with `build.ts`; generates output.
- `bun run test` — run `bun test ./tests`.

## Conventions and boundaries

- Use TypeScript and follow the existing feature-oriented `src/` and mirrored `tests/` layout. Keep all tests under repository-root `tests/`.
- Add focused tests for behavior changes; report only checks actually run.
- Keep the runtime as a single-Agent core. Do not introduce GUI or multi-Agent orchestration unless explicitly requested.
- Keep the TUI as a client of the runtime; preserve the explicit `--no-daemon` in-process path.
- Keep Model Gateway and local runtime service code under `src/daemon/`. Follow the runtime architecture and model integration specs; keep runtime-service credentials separate from Gateway tokens.
- Do not hand-edit generated output such as `dist/` or `packaging/out/` unless explicitly required.
- Check the working tree before editing and preserve existing user changes.
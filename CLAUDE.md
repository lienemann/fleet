# fleet

Personal supervisor daemon and web UI for parallel Claude Code agents. `docs/design.md` is authoritative;
`docs/mockup/` is a visual reference only (it runs in the Claude design canvas, not here).

## Layout

- `src/shared/`: event types, wire protocol (zod, validated by the daemon only) and the pure reducer that derives
  all state from the event log. Daemon and browser both fold the log through it, so the UI is a replay.
- `src/daemon/`: SDK sessions (`session.ts`), task lifecycle and the fleet tools' host (`supervisor.ts`), the
  in-process MCP tools (`tools.ts`), SQLite event log, HTTP/WebSocket server, review backend, jj orbit, power.
- `src/web/`: React UI, served from `dist/web`. Every user action is a command in `keys/keymap.tsx`'s registry,
  so it gets a key, an entry in the `?` overlay and the palette.
- `tests/`: vitest; sessions run against a fake `query`, never the real SDK; review tests use real jj repos.
- `e2e/`: Playwright in three browsers against demo daemons (`FLEET_DEMO=1`, scripted agents in `demo.ts`).
- `vendor/`: byte-identical upstream copies; never edit or format them (see their READMEs).

## Conventions

- Task state (board column) is the supervisor's; sessions only report activity. "Needs you" is derived.
- New event kinds go into `events.ts`, the reducer and, if the browser needs them, the projection; keep the
  projection bounded.
- Node runs the TypeScript directly: only erasable syntax, imports with `.ts` extensions.

## Commands

`just develop | format | lint | test | e2e | run | demo`. Version control is jujutsu; `.fleet/` and `~/.fleet/`
are runtime state.

# fleet

A personal daemon and web UI for running several Claude Code agents in parallel. `docs/design.md` decides what
fleet should do; `docs/mockup/` shows how it should look, but runs only in the Claude design canvas.

## Layout

- `src/shared/`: event types, the WebSocket protocol (zod schemas, checked by the daemon only) and the reducer
  that computes all state from the event log. Daemon and browser both run it over the same events, so the browser
  shows exactly what the log says.
- `src/daemon/`: SDK sessions (`session.ts`), the task lifecycle and what the fleet tools do (`supervisor.ts`),
  the tool definitions (`tools.ts`), the SQLite event log, the HTTP/WebSocket server, the diff view's backend,
  jj orbit and the Mac's sleep control.
- `src/web/`: React UI, served from `dist/web`. Every user action is a command in `keys/keymap.tsx`'s registry,
  so it gets a key, an entry in the `?` overlay and the palette.
- `tests/`: vitest; sessions run against a fake `query`, never the real SDK; review tests use real jj repos.
- `e2e/`: Playwright in three browsers against demo daemons (`FLEET_DEMO=1`, scripted agents in `demo.ts`).
- `vendor/`: byte-identical upstream copies; never edit or format them (see their READMEs).

## Conventions

- The supervisor sets a task's state (its board column); a session only reports what its process is doing.
  "Needs you" is computed from both, never stored.
- A new event kind goes into `events.ts` and the reducer. State the reducer keeps must stay bounded (see the
  `*_LIMIT` constants), because every new browser tab receives all of it.
- Node runs the TypeScript directly: only erasable syntax, imports with `.ts` extensions.

## Commands

`just develop | format | lint | test | e2e | run | demo`. Version control is jujutsu; `.fleet/` and `~/.fleet/`
are runtime state.

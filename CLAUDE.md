# fleet

Personal supervisor daemon and web UI for parallel Claude Code agents. `docs/design.md` is authoritative;
`docs/mockup/` is a visual reference only (it runs in the Claude design canvas, not here).

## Layout

- `src/shared/`: event types, wire protocol and the pure reducer that derives state from the event log.
  Daemon and browser both import it, so the UI is a replay of the log.
- `src/daemon/`: Agent SDK sessions, SQLite event log, permission routing, HTTP/WebSocket server.
- `src/web/`: React UI, served by the daemon from `dist/web`.
- `tests/`: vitest; sessions are tested against a fake `query` function, never the real SDK.

## Commands

`just develop | format | lint | test | run`. Version control is jujutsu; `.fleet/` and `~/.fleet/` are runtime state.

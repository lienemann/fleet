# fleet UI mockup

Clickable mockup of the fleet web UI, exported from the "Agent Supervisor UI" Design canvas on claude.ai:
https://claude.ai/artifact/QQYotDUQxSEBh7ubMUTNq2

- `Main.dc.html`: app shell and all six views (Board, Inbox, Grid, Timeline, Flow, History), drawer, director dock,
  open points, light/dark themes (`.th-dark` / `.th-light` CSS variables in the `<helmet>` block).
- `Tile.dc.html`: the session tile (TUI-style log, filters, decision bar, side-agent note, CLI bar, slash menu, color picker).

Format: Design Component files (`<x-dc>` template with `{{holes}}`, `<sc-for>`, `<sc-if>`, `<dc-import>`, and a
`class Component extends DCLogic` script). They only run inside the canvas runtime; read them as a reference for
layout, styling tokens, interactions and the state model, not as code to ship.

Not a spec: agent names, tasks, file paths, numbers and the tick-driven agent simulation are sample data.
docs/design.md is authoritative where the two differ.

Colors: the mockup colors each agent and lets you pick the tile's color. In fleet the color belongs to the project and
is chosen in the rail's project head or the palette, so read the swatch row and the agent colors as the project's color.

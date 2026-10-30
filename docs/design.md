# fleet — design for an agent supervisor around Claude Code

Oct 22, 2026 · @Jan Lienemann

## Goal and scope

fleet is a personal web UI and daemon that let one engineer run 4–8 Claude Code agents in parallel, with a director session as the single point of contact. It replaces today's tmux grid: readable output, one place for everything that waits on me, and review built in.

**Problems it solves**
- I can't see at a glance who is blocked on me, who is working and who is done.
- Decisions, permissions and "I wrote a Markdown file with open points for you" are scattered across terminals.
- Coordination is manual: I spawn sessions, paste context, collect results and re-review whole diffs after every revision.
- Review is the bottleneck, not code generation.

**In scope**
- A daemon that runs Claude Code sessions through the Agent SDK, on the Mac first and on Coder pods later.
- A director session that plans, spawns workers with context, tracks a task ledger and collects results.
- A web UI with board, inbox, grid, timeline, flow and jj history views.
- An own diff view built on reviewdiff-core, with hunk approvals, small edits and threads on lines that agents answer.
- jj workspaces as the isolation unit; jj orbit for history.

**Non-goals**
- A product for other people. It is a personal tool; colleagues would run their own instance with their own login.
- VS Code integration. Not needed; the web diff view covers review.
- Supporting agents other than Claude Code.
- A cloud service. Everything runs on my Mac or my Coder pods, reached through tunnels.

**UI reference:** the clickable mockup on the Agent Supervisor UI canvas (light and dark theme, all six views).

## Architecture

A daemon on each host runs all Claude Code sessions through the Agent SDK and owns the event log; the web UI is a disposable view that reconnects and replays.

&#91;embedded content: architecture · Mac and optional Coder pod\]
- **Daemon** (TypeScript, Agent SDK): one `query()` per session with streaming input; routes `canUseTool` to the inbox; serves the custom tools in-process; writes every event to SQLite; serves the web UI, jj orbit and the diff view on `127.0.0.1`.
- **Sessions:** the director plus one worker per jj workspace. Workers spawn their own subagents; Claude Code's "You should know" side agent runs alongside each worker.
- **Web UI:** connects over a WebSocket and asks for events since its last sequence number. Closing the tab, losing Wi-Fi or a daemon restart costs no agent work.
- **Coder pods:** run the same daemon. The UI on the Mac connects to every daemon through ssh or Coder port forwarding and merges their events. Pods don't sleep, so long builds and benchmarks go there.
- **Resilience:** a watchdog spots failed turns (API or network errors), backs off and resumes the session; the UI shows "reconnecting", not "failed".

## Agents and roles

The fleet director is my single point of contact. Each project has a director of its own that plans and delegates there; no director implements. A project director's own subagents may run a small check; larger checks and every change go to a worker, so they show on the board with a diff and my review. A director edits code, itself or through a subagent, only when I tell it to: its checkout is the repo I work in, so each such edit asks me in the inbox, whatever the permission mode. Workers do the work in their own jj workspace and spawn subagents as they see fit.

| Role       | Count                       | Runs where                              | Can do                                                                                                                   | Cannot do                                   |
| ---------- | --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Fleet director | 1                       | Mac, no repo of its own                 | Everything I can do in the UI except the inbox: tasks in any project, moves, settings, workspaces, projects; coordinate projects, link tasks across them | Edit code; answer permission prompts, decisions or reviews for me |
| Director   | 1 per project               | Mac, the project's default workspace    | Start tasks for workers and investigators; interrupt its agents; park, unpark and drop its tasks, pass context packs, keep the ledger, collect reports, answer workers' questions it is sure about; small checks through its own subagents | Edit code unless I ask and approve each edit; answer permission prompts for me |
| Worker     | one per workspace           | Mac or Coder pod, one jj workspace each, for good | Edit, run tests, spawn subagents, ask me, report                                                               | Touch other workspaces; rewrite trunk       |
| Investigator | as many as the limits allow | Mac, the project's default workspace  | Read, run read-only checks, answer, report findings                                                                     | Edit code; take a workspace                 |
| Subagent   | per worker                  | inside its worker's session             | Explore, write tests, review                                                                                             | Talk to me directly                         |
| Side agent | one per worker, opt-in      | a side question to the worker's session | Leave notes ("You should know")                                                                                          | Act on anything                             |

**Tasks and agents.** A task is a ticket, and it ends. An agent is a worker that outlives its tickets and goes back to the pool after each one. The board shows tasks; the rail shows agents.

A task moves Queued → In progress → Review ⇄ Changes requested → Done, with Parked and Dropped beside that path. Done and Dropped are final.
- Queued waits for a free agent of the right kind and for room in the WIP limits: 4 in progress and 2 in review per project, both kinds of agent counted. The director spawns nothing new while Review is full. A task set to Same worker waits for that one worker even while others are free; its card says "waits on <worker>", in the rail and on the board alike. Drop and Unpin stay possible meanwhile.
- In progress: an agent holds the task. `report_result` moves it to Review. Accept makes it Done; Request changes sends my held thread messages and edits, and the same agent revises in the same conversation.
- Park: the agent writes a short handover note into the ticket, its change stays a jj commit that every workspace of the repo reaches, and the agent becomes free. A parked task is never picked up on its own; Unpark, by me or the director, queues it again, and whichever worker takes it continues on top of the parked change, from the brief and the note, in a fresh conversation. Unpark also offers Same worker: the task then waits for the worker that held it and resumes that conversation instead (see Conversations).
- Drop closes the ticket as Dropped and frees its agent. The change stays in the jj history but leaves the workspace, so the next task there starts clean; when the change holds work, fleet asks me first.

There are two kinds of agent. Claude Code ties a conversation to the directory it started in, so an agent that keeps its conversation stays in its directory.
- A worker changes code and lives in one workspace for good, so the workers of a project are its workspaces: opening a workspace adds a worker. Each new task starts a fresh conversation on a new change from trunk, unless the task is set to Same worker, which continues the worker's conversation.
- An investigator only reads: questions, evaluations, analyses. It lives in the project's checkout, as the director does, edits are refused as they are for the director, and it never takes a workspace. The director picks the kind when it starts work, and so do I in New task; a task that turns out to need code goes to a worker, with the findings in its brief.

An agent is working, waiting or free.
- Waiting: asleep while it holds a task, after an Interrupt, while it waits on another agent, or while it waits on me. Nothing else takes it, so my correction after an Interrupt lands in the same conversation. Another agent may still ask it something; it answers and keeps its task.
- Free: no task. The next queued task of its kind, or a command, takes it. A command without a ticket, such as a director's question, leaves a free agent free again once it is answered.
- Needs you is a mark on an agent and on its task's card, not a column: the agent has something in the inbox for me, a permission prompt, a decision, open points, or a message or closing text I haven't read. Answering it or Mark read clears it, so the board and the inbox never disagree. An agent that answered another agent has nothing for me; its card says whom it waits on.

Interrupt is the agent's only stop: it ends the current turn, and the agent waits with its task and its conversation. Accept, Request changes, Park and Drop act on the task. There is no Start or Stop, because sessions are not mine to manage: an agent wakes with its next prompt, command or task. Handing an agent to a terminal and Attach stay as they are.

**What belongs to whom.** A task keeps its brief, its change, the report, line threads, my held thread messages and review edits, the handover note, and the logs of every conversation that worked on it. Its card's drawer shows all of that, also after the agent has moved on, and Live shows the agent that holds the task now. An agent keeps its name, kind, workspace and current conversation, so a worker's tile starts empty with a new ticket while the previous ticket's log stays with that ticket. Finished items and messages to me belong to the agent and name the task they came from.

**Conversations.** Every new ticket starts a fresh conversation, for investigators as for workers. A command without a ticket runs in the agent's current conversation, since a question to an agent is usually about what it just did. The conversation belongs to the task, and Same worker is what lets an agent pick it up again. It is a choice per task, off by default ("any worker"), in Unpark, New task and `spawn_task` (`same_worker`). The task then waits in Queued for that one worker, and when the worker takes it, it resumes the task's previous conversation by session id on top of the task's change, not from the brief and the note. In New task and `spawn_task`, which name a worker, the conversation is that worker's previous one, with a change on top of the previous one. If the conversation is gone (the session can't be resumed, the workspace or the worker was removed), the task does not start: its card shows a note saying so, with Unpin, which releases the task to any worker and a fresh conversation. Fleet never falls back to a fresh conversation by itself. The WIP limits apply as for any task.

**Investigators** come with need: a ticket or command for an investigator that finds none free starts one. Free investigators stay in the pool, and fleet lets go of free ones beyond two per project.

**Imported sessions.** In a free worker workspace, an imported session becomes that workspace's worker. Anywhere else, in the project's checkout or in a workspace whose worker holds a task, it is a guest: it edits as before, carries the shared-directory warning, never picks up queued tickets, and goes when I remove it. Importing creates no ticket; I can give it one.

**Moves.** Park works from In progress, Review and Changes requested; Drop from every state but Done, Parked included; Unpark from Parked; Unpin from Queued, for a task set to Same worker. A plain Park and Unpark still mean any worker, brief and note. Directors interrupt their agents and park, unpark and drop their tasks, and dropping a change that holds work still asks me; Accept and Request changes stay mine. An agent that stopped without me, offline, after a failed request or a crash, waits with its task, and Continue on its Stopped item, or my next prompt, tells it to go on. Changes requested counts against the In progress limit. While Review is full, a director may still create tasks; they wait in Queued. An agent waits on the agent it last messaged before going idle; there is no blocking ask.

Drafts live in the browser's storage, so they stay on the device I typed them on.

## Projects

I work on more than one repo at a time, fleet, ReviewDiff and jj orbit for example, and sometimes one change needs two of them. One fleet runs all of them.

**A project is one jj repo:** its default workspace, its worker workspaces, the repos its agents may read but not change, and its own WIP limits. A fleet-wide limit on running workers and tasks in review sits on top; a queued task starts when both its project and the fleet have room, and either limit can be set to unlimited. Directors count toward neither. `config.toml` lists them under `[[projects]]`, each with a name, the default workspace's path, `[[projects.workspaces]]` and `read_only`. "+ Add project" in the rail takes a directory, finds the jj repo and its workspaces, and offers them; the project's director starts at once. Fleet's own state directory (`~/.fleet` or `FLEET_HOME`) and anything inside it is never a project. Without a `config.toml`, fleet starts with no project, and the rail and the empty board offer "+ Add project". Remove project in the rail asks first, then ends the project's director and takes the project out of fleet and `config.toml`; the repo and its workspaces stay on disk. It is refused while any of the project's tasks is still open, so no card is left without its project. Only I remove projects; directors don't.

**Directors.** Each project has a director in its default workspace, with that repo's CLAUDE.md and context. Above them, the fleet director has no repo. It runs in fleet's own state directory and reaches the projects through fleet's tools. It knows every project and what runs where, reads every project's code without changing it, starts work in any project, moves cards, changes settings, adds workspaces and projects, and coordinates work that spans repos. A task belongs to its project's director whoever created it, as one I create in the UI does today, so reports and questions from its worker go there. The fleet director gets a short list of tools rather than every command of the UI. It does not touch the inbox: permission prompts, decisions and reviews stay mine, and so do Accept and Request changes, permission modes, allowed tools, auth and whether fleet opens workspaces without asking. Dropping a task whose change holds work asks me first, as it does in the UI. The dock talks to the fleet director; a picker in the dock switches to a project's director.

**Messages between projects.** An agent sees and messages the agents of its own project. A message to an agent of another project is refused with a hint to ask its director. Directors, the fleet director included, message anyone. For work across repos a director links a task of its project to a task of another project, without asking that project's director; from then on the two find each other in `list_agents` and message each other, and the link ends when either task is Done or Dropped. A link opens messages only; it does not show one task the other's report or diff. The bus shows both projects on a message between them, and each card shows its links.

**Reading other repos.** A project's `read_only` repos, such as ReviewDiff's next to fleet, go to the SDK as `additionalDirectories`, and its agents read them without asking, as they read their own workspace. Reading anywhere else and writing there still go to the inbox.

**One view.** Board, grid, inbox, timeline and flow show the agents of all projects. Each card and tile carries its project's name and color, the rail groups agents and workspaces by project, and a filter narrows every view to one project. The history view shows one repo at a time and picks the project. Pods keep their own daemons and projects; the browser merges them as before, and the fleet director acts on this daemon's projects only. The `/mcp` endpoint for sessions outside fleet picks the project from the caller's directory.

**Colors.** Color means the project. Every project has one, kept in its `[[projects]]` table in `config.toml` as `color = "#rrggbb"`, and everything that belongs to its tasks and agents wears it: cards, tiles, the drawer's header, rail rows and the project's block, inbox items, flow packets, the bus ticker and the project picker of the history view. A task that no agent holds yet has its project, so it is colored all the same. A project added without a color takes the first palette color no other project has, and a repeat only comes once the palette is used up, so two projects tell apart on sight. I change it with "Color" in the project's rail head, or "Color of <project>" in the palette, which offer the palette and any color of my own; the daemon writes the choice into `config.toml`, comments and all. Agents have no color of their own: agents of one project differ by name, so a name is the label wherever an agent shows up, and, once there are several projects, the project's name follows it in the project's color, as in the inbox, the drawer's header, a card and a tile; the rail's project blocks and the director dock leave it out, since the place says which project it is. The fleet director has no project and wears a neutral grey.

**Turning directors off.** A project's director can be switched off in its config, as today; the fleet director always runs, since it is also how the app gets configured by talking to it.

## Protocol

Agents never format their replies as JSON. Structure comes from three sources: the SDK event stream, the SDK permission callback, and a small set of custom tools served in-process by the daemon. Tool calls are schema-validated, so the agent's prose stays natural.

| Tool                 | Who calls it  | Payload                                                    | What the UI does                                                                   |
| -------------------- | ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `request_decision`   | any worker    | question, context (multi-line), options, risk tags         | Inbox item and decision bar on the tile; the answer is the tool result             |
| `request_review`     | any worker    | path, kind (plan, doc, mockup)                             | Review item; opens the file in the viewer                                          |
| `submit_open_points` | any worker    | path of a Markdown file with `- [ ]` items                 | Points parsed into the inbox; answers go back as one message once all are answered |
| `report_result`      | any worker    | summary, jj change ids, tests, open questions, walkthrough, files | Card moves to Review; report tab filled, attached files listed in it        |
| `attach_file`        | any worker    | files: absolute path and an optional one-line note each    | Files in the task's Files and Report tabs, opened in the viewer                    |
| `report_status`      | any worker    | one-line status, to-do progress                            | Card subtitle and timeline                                                         |
| `reply_thread`       | any worker    | thread id, body (multi-line)                               | Reply under the lines in the diff; Replies item in the inbox                       |
| `send_message`       | any agent     | to, body (multi-line)                                      | Message bus, flow view, both transcripts                                           |
| `spawn_task`         | director only | title, context pack, workspace, host, `same_worker`        | New worker on the board; with `same_worker` the task waits for the named worker    |
| `ledger`             | director only | read or update tasks                                       | Director's view of the board                                                       |

**Decisions and permissions.** `canUseTool` turns every permission prompt and every `AskUserQuestion` into an inbox item. Each item carries Claude's explanation: the text it wrote just before the call, taken from the stream, plus risk tags the daemon derives from the command (network, writes outside the workspace, runtime).

**Open-point documents.** When a worker writes "I've put the open points in X.md for you", the prompt contract makes it call `submit_open_points`. As a fallback the daemon also watches for new `.md` files under `.fleet/<agent>/` and parses `- [ ]` items.

**Messages.** All agent-to-agent traffic goes through `send_message`, never Claude Code's built-in cross-session messaging, so the daemon sees and logs every message. Bodies are multi-line Markdown.

**Walkthroughs.** `report_result` includes a walkthrough written with the AI instructions from the ReviewDiff README, with permalinks pinned to change ids. Hunks the walkthrough doesn't cover are flagged in review.

**Files for me.** A worker's review files, plans and deliverables often live outside its workspace, such as Claude's `plans/`, and may come from a Bash command that fleet cannot see. So the worker attaches them, with `attach_file` while it works or `files` on `report_result`, each with an optional one-line note. Naming a path in the report text attaches nothing. Fleet does not watch files for changes, so a file counts as delivered only once the worker has reported after attaching it: until then the Files tab lists it as "may still change", and the Report tab does not show it. The Files tab lists what the worker attached and reported first, then its notes under `.fleet/<agent>/`, then every file it wrote with Write or Edit, in the workspace or elsewhere, each file once. The Report tab lists the delivered files under the summary. Every entry opens in the same viewer: Markdown rendered, other text with syntax colors, a notice for a binary file or one over 512 KiB. The event log keeps paths, notes and a bounded number of them (the latest 50 per task); the content is read from disk when I open a file, on the daemon of the host the agent runs on.

**Side agent.** Claude Code's "You should know" plugin runs only in its terminal UI, so fleet does the same thing itself, switched on per agent: after each turn it asks the session a side question, without tools, whether there is something I should know but might miss. A note appears above the tile's prompt and in the inbox's FYI section; "Tell agent" forwards it as a user message.

**Finished runs.** An agent's closing message after a long run (what it did, what is left, what I need to decide) is the part I read most closely, so it doesn't stay buried in the log. When an agent goes idle after at least 15 seconds of work that I started (my prompt, a new task, Request changes, a thread message, Go), the inbox gets a Finished item with the last text it wrote, rendered as Markdown. One stretch of work makes one item, however many turns it took: prompts I queued mid-turn, or the agent waking itself when a background shell ends, belong to the same stretch. Work another agent started makes no item when the agent messaged an agent during it, since the answer went there; if it needs me, the agent messages me. Work another agent started that ends without any message makes an item, so nothing ends out of my sight. Everything meant for me to read lands in the inbox exactly once: a run that messaged me makes no Finished item, because the message is its item, and a worker's answer to its director reaches me only if the director passes it on. Around ten seconds is where people stop waiting for an answer and turn to something else, so a quick reply I sat and waited for makes no item. Only the time the agent worked counts, not the time it waited on my permission prompts, and the threshold is a setting in `config.toml`. A stretch I ended myself (Interrupt, Stop, a handover) makes no item, since I was there. A stretch that ended without me, because the network went down, the request failed or the process crashed, always makes one, however short and whoever started it: tagged Stopped, with the reason and the last text the agent wrote, so I know to have it continue. If I was watching when the turn ended (the agent's drawer or enlarged tile open in a focused browser window), the item lands unread like any other, because an open drawer is often a side pane and not a sign that I am reading it. The `read_while_watching` setting in `config.toml` (off by default) sends such an item straight to Read.

The inbox groups Finished items by agent. The newest unread one is on top and unfolds first; older unread runs of the same agent sit under it as one line each, and each unfolds to its full text, so a decision asked for an hour ago can't hide behind a later summary. Folded, an item shows the agent, its task, how long it ran, when it ended and the first line of the message. Unfolded, it has a comment box and two buttons:
- **Mark read** with the box empty: the group moves to Read without waking the agent. With text in the box the button reads **Send**: the text goes to the agent as a prompt, and the group moves to Read.
- **Go** sends "Go ahead.", for when the agent waits for my go, and moves the group to Read.

Messages agents send me sit in the same group as the agent's Finished items, with the same comment box and buttons, and move to Read the same way. Only these buttons move items to Read. Opening the agent, typing in its tile or answering its decisions leaves them where they are, so nothing I only glanced at disappears. Read keeps the last 20 Finished items per agent, folded at the bottom of the inbox. A new item raises a notification and marks the agent new; the session log keeps everything regardless.

## Event model and storage

The daemon is the only stateful component: one append-only SQLite event log per host, from which every view is derived. The browser holds no state of its own.

**Event log.** Every SDK message, permission request, custom-tool call, state change, message and user action becomes a row: `seq`, `ts`, `agent`, `parent` (for subagents, from the SDK's parent tool-use id), `kind`, `payload` (JSON). The UI connects over a WebSocket and asks for events since its last `seq`; the daemon replays what it missed, then streams.

**Derived state.** Agent state, the task ledger, inbox items, open points, unseen marks and timeline segments are projections of the log, rebuilt on start and updated incrementally. The director's ledger is the same projection, served to it through the `ledger` tool.

**Sessions.** Claude Code keeps its own transcripts; the daemon stores each agent's session id and resumes with it after a restart. A request that was pending during a restart is marked stale; the agent asks again after resuming.

**Unseen.** An agent is marked new when its outcome changes: it needs me, it reaches review, it creates a file for me, it finishes a long run, or the side agent leaves a note. New log lines don't count. The mark stays until I open the agent; "Mark all seen" clears all.

**Files on disk.**

| Path                                                       | Content                                             |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `~/.fleet/fleet.db`                                        | Event log and projections                           |
| `~/.fleet/config.toml`                                     | Hosts, projects with their colors, workspaces, WIP limits, sleep policy |
| `<workspace>/.fleet/<agent>/`                              | Reports, open-point files, context packs            |
| ReviewDiff `approvals.json` (common git dir or `.jj/repo`) | Hunk approvals, read and written by the diff view   |

Data that comes and goes with tasks, sessions and agents lives in `fleet.db`: the event log, an agent's model, effort and tint, its threads and open points. Configuration whose lifetime doesn't depend on any project or task lives in `config.toml`: hosts, projects with their colors and workspaces, limits, the sleep policy, thresholds such as the one for Finished items. I can edit the file by hand or keep it with my dotfiles, and the settings in the UI write to the same file. Resetting `fleet.db` then costs history, never configuration.

## UI

One web app served by the daemon, with six views over the same task data. Selection is shared: a task picked in one view stays picked in the others. The mockup on the Agent Supervisor UI canvas is the reference for layout and behaviour.

**Shell (every view)**
- Header: view switcher (keys 1–6), counters (working, need me, in review, open points, new), New task, lid-closed mode, theme, command palette (⌘K).
- Bus ticker: the last two messages, each with a packet that crosses from sender to receiver three times when it arrives and then rests at the receiver; multi-line bodies show their first line plus a line count.
- Director dock: the director's latest reply and a prompt to it.
- Left rail: agent tree (director → workers → subagents) in the project's color with status dots and "new" marks. Under each director, agents sort by what they need from me: Needs you first, then working, waiting and free ones, each with its current task; free agents stay listed, dimmed, so none disappears with its ticket; hosts and jj workspaces, each with the disk it takes and Purge. With several projects, each project's agents and workspaces sit in an indented block under its name; clicking the name, or "Fold <project>" in the palette, folds the block away, leaving a dot if an agent of that project needs me, and the fold survives a reload.
- Right drawer: Live (the tile), Files, Diff, Report, Messages for the selected task. Its header names the agent and the project, in the project's color.
- Both sidebars resize by dragging their inner edge, or by focusing it and using the arrow keys, Home and End. Neither can squeeze the main area below a usable width. A double click on the edge, or "Reset the sidebar widths" in the palette, brings the default back, and the widths survive a reload. The Diff tab's wide drawer keeps its own size.
- Each sidebar collapses to a thin strip with a button that brings it back (⌥H for the rail, ⌥L for the drawer), keeps its width for then, and stays collapsed after a reload; opening an agent shows a collapsed drawer again. ⌥Z, or the button in the drawer's header, expands the drawer over the whole window, board and rail included, and back; it is the same drawer, so its draft, scroll and selection stay. Esc stays Interrupt, so it does not leave the full window.
- In a wide inbox or drawer, running prose (agent text, Finished items, messages, notes, decisions) stops at about 90 characters and sits at the left, so lines stay easy to read; code, diffs, tool output and tables use the full width.
- Views and tabs keep their state. A view I leave stays mounted, hidden, after its first visit, so History keeps its project, jj orbit its camera and revset, and a tab its scroll position. Text I type is a draft per agent or item, in the prompt, the inbox's comment boxes, New task and line threads, and survives switching views and reloading the page until I send or clear it.

| View     | Answers                     | Notes                                                                                                                                           |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Board    | Where is each ticket?       | Columns Queued, Parked, In progress, Review, Changes requested, Done (Dropped folded under it); the Needs you mark on cards; WIP limits on In progress and Review; buttons are the moves you would drag |
| Inbox    | What waits on me?           | Every item names its agent and project, in the project's color; decisions and permissions with Claude's explanation and risk tags; open points; replies in line threads; finished runs; side-agent notes; whether to open a workspace |
| Grid     | What is happening now?      | Live tiles; enlarging one turns the rest into a status strip                                                                                    |
| Timeline | Where was I the bottleneck? | One lane per agent; waiting-on-me time in orange; 15 min or 2 h window                                                                          |
| Flow     | Who talks to whom?          | Agents as nodes, messages as packets in the sender's project color; click a link to filter                                                              |
| History  | What happened to the repo?  | jj graph of all workspaces, classic or 3D; op log as checkpoints                                                                                |

**Tile.** Mirrors the TUI: live log anchored at the bottom, filter All / Main / Subagents, to-do list, files for me, decision bar with explanation and risk tags, side-agent note, and a CLI bar with permission mode, model, context meter, Interrupt, Rewind and `/compact`. Under a turn, the card of edited files names each file as a link that opens the task's diff at that file, in all changes since trunk; a file outside the workspace, one under `.fleet/`, or an agent without a task has a disabled link whose tooltip says why. The prompt has a slash-command menu and an attach button. The tile's header names the agent and its project, and the project's color marks the tile; its tint setting (off, soft, medium, strong) says how much of that color goes into the background of the tile and its card.

**Theming.** Dark and light. Light is beige with a dark red accent and serif headings; project colors switch to darker variants so they stay readable, a color of my own included. In dark, one too dark to read is lightened. All colors are CSS variables per theme.

**Keyboard and mouse.** Everything is reachable by both. Every shortcut that is a letter, digit or sign takes Option (Alt elsewhere), as in ⌥N for New task and ⌥2 for the inbox, so keys typed while the focus is somewhere unexpected never start anything. Fleet reads the physical key, because Option turns letters into other characters on the Mac. A chord starts with an Option stroke and goes on with plain ones, as in ⌥G then `b`. Only the keys that walk lists stay plain (`j`, `k`, `[`, `]`), with `Enter` and `Esc`, ⌘K for the palette and `?` for the overview, and a plain key works only while the focus is inside a pane, never on the bare page. The rail, the view and the drawer are panes: a command that belongs to one (⌥A approves the inbox's focused permission in the view and the selected agent's in the drawer; the diff approves a hunk with ⌥Y) fires only while the focus is in that pane, and beats a command with the same keys that belongs to none; Option keys with nothing focused go to the view. ⌥7, ⌥8 and ⌥9 focus the rail, the view and the drawer, ⌥← and ⌥→ go from pane to pane, Tab goes on inside one, and a click focuses the pane it lands in. The pane that owns the keys wears an accent outline, and so does the view while the focus is outside every pane. The same keys across panes mean the same thing on that pane's own target (approve, reject, open, close), and a key never means two different things. Mouse only where the gesture is the point: dragging a card to another column (the move commands do it by key), dragging a sidebar's edge (it takes the arrow keys too), selecting lines of a hunk for a thread, and hover for details.

## Review and diff view

fleet has its own diff view in the browser, built on reviewdiff-core, so review never needs VS Code. It shares ReviewDiff's approvals file: an approval made in either tool counts in both.

**What it reuses from reviewdiff-core**
- Hunks identified by a hash of path and removed and added lines. Approvals survive rebases and agent revisions, so after "Request changes" only the hunks the agent touched come back.
- Moved-code detection across files, with both ends linked and approvable together.
- Formatting-only and whitespace-only hunks recognised and approved from the start.
- "Changed since approval": a diff of the approved lines against the current ones.
- Walkthrough order: review the hunks in the order the agent's walkthrough discusses them; hunks it doesn't mention are flagged.

**What the view shows**
- Side-by-side or inline diff of a task's jj change against trunk, one file after another, with syntax highlighting.
- A scope picker: all changes since the fork point from trunk, or one of the task's commits against its parent, stepping older and newer by key.
- Opening it from a file name, such as one in the tile's edit card, scrolls to that file and focuses its first hunk; a file the diff does not hold is named in a notice.
- Per hunk: Approve and next, Skip, Ask (opens a thread on its changed lines). Progress ("3/9 hunks approved") on the card and in the drawer.
- Accept with unreviewed hunks is allowed but says how many.

**Line threads.** I select one or more lines of a hunk, on either side, and write a question or a complaint: "this error message is hard to understand", "why this function and not the other one?". The diff is always one task's, opened in its drawer, so the thread belongs to that task's agent. By default it goes to the agent at once, as an ordinary user message that quotes the lines with file, line range and the short id of the commit that last changed them, so the agent sees it in its session like anything I type in the tile. The message names the thread and asks the agent to answer with the `reply_thread` tool; the answer appears under those lines, in a thread like a GitLab discussion where I can reply again. A message can land in a turn that is busy with other work, or share a turn with other threads, so only `reply_thread` counts as an answer: a thread the agent leaves unanswered says so, and its prose stays in the session. Both sides of the exchange show in the tile and the Live tab, my messages with a link that opens the thread in the diff. Like a prompt typed in the tile, a thread message stays off the message bus. Small edits I made since the last message to the agent go along with the next thread message, so the agent never answers about lines I have already rewritten.

The composer has two checkboxes:
- **Hold for Request changes.** The message waits in the draft instead of going out, and I can edit or delete it there. "Request changes" sends every held message as one change request, each with its thread, and from then on they are threads like the others.
- **Fold the fix into `<commit>`.** Shown when one of the task's own commits wrote the selected lines (new side) or deleted them (old side). For deleted lines the daemon follows them through the task's commits, oldest first, and names the commit in which they disappear; lines that went in two different commits, or that the task never touched, name none. The message says "deleted in commit `<commit>`" for those, so a question like "why did this check go?" reaches the commit that dropped it. The message then asks the agent to put any fix into that commit (`jj squash --into`), so the history reads as if it had been right from the start. Off by default, since most questions change nothing. The agent does the folding itself, so the daemon never rewrites history under a running agent.

Asking at once doesn't move the card: a task in Review stays there, and if the agent changes code in answer, the hunks it touches lose their approval, as after Request changes. While the agent is busy, the message waits in the prompt queue like any other. A thread keeps the path, side, line range, quoted text and commit from when I opened it. The daemon places it against the whole branch: at the hunk that still holds that text, or, once the agent has changed those lines or the file has left the diff, marked outdated. In a single-commit scope, threads whose lines aren't in that commit, and outdated threads in every scope, are listed above the first file, each with a link to its place. Only I resolve a thread. Resolved threads fold away, and the state keeps a bounded number of them per agent.

An agent's reply puts the thread in the inbox's Replies section and marks the agent new. Opening the item jumps to the thread in the diff; reading, answering or resolving it clears the item. Threads are mine, like reviews: directors neither see nor answer them.

**Small edits in the diff.** I can edit a few lines myself, typically code comments, docstrings and typos, without a round-trip to the agent:
1. Edit lines on the right side of a hunk in place.
2. The daemon applies the edit to the commit that last changed those lines, like ReviewDiff's Edit in Commit: `jj new` on that commit, write the file, `jj squash` back. jj rebases the descendants.
3. The hunk is approved as edited; the agent gets a short message listing what I changed.

Edits are only allowed while the agent isn't running in that workspace (Review, Changes requested, or interrupted), so they never race with the agent's own writes. Everything goes through the op log and can be undone with `jj op restore`.

**Later:** a read-only viewer for any file in the task's workspace, so a thread can point at code the change never touched ("this duplicates `parse_header`"). Threads already anchor to path and quoted text rather than to a hunk, so the viewer reuses them.

**Out of scope for now:** GitLab merge request discussions in the web view. ReviewDiff in VS Code keeps covering MR review.

## jj integration

Each worker owns one jj workspace; the director and I share the default one. jj replaces git worktrees as the isolation unit, and jj orbit replaces a second jj client.

**Workspaces.** Configured in `config.toml` per host (`fleet-ws1`–`fleet-ws4` on the Mac, more on pods). Background-session worktrees from Claude Code stay off: the daemon starts each SDK session with its workspace directory as working directory. Each workspace is home to one worker. A task that names a worker or its workspace waits until that worker is free.

A task that names none goes to any free worker of its project when it first starts; New task offers that as its default. A task that has started stays with its worker until it is Done, Dropped or Parked, since its working copy is there. Same worker on an unparked task makes it wait for the worker that held it, as naming a worker does.

**Opening a workspace.** When a task for a worker could start, because the WIP limits have room, and only a free worker is missing, usually because the workers hold tasks in Review, fleet asks me in the inbox whether to open a new workspace, which adds a worker, or wait. It asks whether I, a director or the queue started the task, and also for a project that has only its default checkout. The question carries what I need to decide: free space on the repo's volume, what a new workspace will probably take (the size of the project's largest worker workspace, or of its checkout while it has none), free memory, CPU load, and how many workers run against the WIP limits. Open runs `jj workspace add` and names the workspace after its project, `fleet-ws5` in the directory `fleet-ws5` next to the repo, with the lowest number that no workspace name, jj workspace or directory uses yet; `fleet init` names its workspaces the same way. Fleet writes the new workspace into `config.toml` for good and starts the task there. Wait queues the task until a workspace frees up, and the question doesn't come back for that task. Add workspace in the rail has New workspace next to the existing directories: it opens one the same way and shows the free space and the estimate before I confirm, and as I asked for it, no inbox question follows. A director's `add_workspace` still only adds a directory that exists; fleet creates one only through this question or my New workspace.

`open_workspaces = "auto"`, at the top of `config.toml` or in a project, lets fleet open a workspace without asking while the project has fewer than `max_workspaces` (default 8, configured ones included) and the volume keeps `disk.min_free_gb` free after the estimate. A project's value overrides the top-level one key by key. When either check fails, the question comes to the inbox with the reason, such as "8 of 8 workspaces". The default is `open_workspaces = "ask"`. Directors can't change these settings, so none of them can switch the question off for itself.

**Size and Purge.** The rail shows each workspace with the disk it takes, measured in the background when the daemon starts and when a run in it ends. Purge, offered while no agent runs there, lists the folders in it that jj ignores and fleet knows how to get back, each with its size, cheapest to rebuild first and largest first within that: caches (`__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`) and build output (`target/`, `dist/`, `build/`) come checked, installed dependencies (`.venv`, `node_modules`) unchecked, because a `.venv` may hold packages installed by hand that no lock file knows about. Nothing outside that list is ever offered, so `.env` files and `.fleet/` stay.

**Removing a workspace** asks whether to delete its directory as well. Yes snapshots it, so its last edits stay in the repo, runs `jj workspace forget` and deletes the directory; no only takes it out of `config.toml`. A workspace in use and a project's last workspace stay, as before.

**History view.** Embeds jj orbit, served by the daemon. Its flat layout is the classic graph; lanes and spiral are the 3D modes. Orbit colors the commits by workspace itself; the project picker above it wears the project's color. Orbit follows a `data-theme` on its root, which fleet sets from its own theme, so the vendored copy stays as it is.

**Op log as checkpoints.** Every jj operation is attributed to an agent (by workspace) or to me. The op slider scrubs through them; picking an older op fades later commits and offers `jj op restore` with a preview first. This replaces per-session checkpoints: rewinding an agent is restoring the op before its last turn.

**Where 3D helps.** As an overview, not for doing: many parallel lanes on a second screen, time as depth, spatial memory of which stack is whose. Classic stays the default for review and actions.

**Write safety.** jj snapshots continuously, so nothing an agent did is lost. The daemon never runs history-rewriting commands on a workspace while its agent is running.

## CLI parity

The Agent SDK runs the same harness as the CLI, so most capabilities exist; the work is rendering them. Commands that open interactive TUI dialogs in the CLI need a check for an SDK equivalent, one by one.

| CLI feature                            | fleet                                        | Phase |
| -------------------------------------- | -------------------------------------------- | ----- |
| Transcript with tool calls and results | Tile log, filter main / subagents            | 1     |
| Permission prompts, AskUserQuestion    | Inbox and decision bar, with explanation     | 1     |
| Prompt, interrupt (Esc)                | Tile prompt, Interrupt button                | 1     |
| Permission modes (Shift+Tab)           | Mode pill: default, plan, accept edits, auto | 2     |
| Model and effort                       | Model pill                                   | 2     |
| Context usage, `/compact`              | Context meter, button                        | 2     |
| To-do list                             | To-dos panel                                 | 2     |
| Slash commands                         | Menu on `/`                                  | 2     |
| Subagents                              | Tree, tile filter, flow view                 | 2     |
| Rewind (Esc Esc)                       | jj op restore plus session fork              | 3     |
| `@` file mentions                      | Autocomplete from the workspace              | 3     |
| Image paste and attachments            | Attach button, paste                         | 3     |
| Messages queued while busy             | Queue shown under the prompt                 | 3     |
| `/btw` side questions                  | `/btw` in the prompt, answer above it        | 3     |
| Plan mode output                       | Plan as a doc with comments, then approve    | 3     |
| Background tasks and watchers          | Activity tab: output, Stop, Ctrl+B           | 3     |
| Cost and usage                         | Per agent, per day                           | 3     |
| Skills, hooks, MCP, plugins            | Read-only list; manage in the CLI            | later |

**Background tasks.** The Activity tab lists, above the tool calls, what a session runs on its own: shells, monitors, workflows and background subagents, from the SDK's `task_*` messages. A command that holds up its tool call is listed too while it runs, with Move to background (Ctrl+B in the CLI), and drops out of the list if it ends there. A shell's row shows its command, how long it has run and when its output last grew. Fleet cannot know whether a process hangs, so output that stays quiet for two minutes is the hint: the row turns amber. The session samples the output every 5 s while a shell runs, so the hint is right even when nobody had the tab open. Opening the row shows the end of the output (the CLI hands out the last 8 KiB), refreshed every few seconds; a finished shell's output comes from the file the CLI names when the task ends. Stop goes to the SDK's `stopTask`. Tasks end with their CLI process, so a stopped, crashed or restarted session marks them stopped. The state keeps the last 20 finished tasks per agent, and Clear drops them.

**Lost connection.** When the network goes down, the CLI retries a request for a while and then ends the turn with an API error. A turn that ended that way (`terminal_reason` "api_error") after retries that got no response at all (`api_retry` without an HTTP status) marks the agent offline. Errors that Claude did answer, such as overloaded or rate limited, do not. An offline agent stays in its column instead of moving to Needs you, and one banner lists all of them. Every 15 s the daemon looks after them. It sends the agent that went offline first a note to continue, and since that goes through the CLI, the CLI's own network settings and retries apply. If it fails again, the next try waits 30 s, doubling up to 5 min. Once Claude answers it, the other offline agents get the same note.

**Escape hatch.** Any agent can be handed to a terminal: the daemon releases the session and prints `claude --resume <id>` for its workspace. Two processes must never write the same transcript, so while another process holds the session, the tile shows it as detached. An imported session starts the same way when something else still has it open.

**Finding the other process.** Every running Claude Code writes `~/.claude/sessions/<pid>.json`: the terminal CLI, the VS Code extension and the Desktop app alike. The file names the pid, the session id, the cwd, whether the process is busy or idle, when it started (`procStart`) and which client it is (`entrypoint`). The format is undocumented, and Claude Code sometimes leaves a file with stray characters after the JSON object that then never updates. The daemon reads such files defensively and, when in doubt, treats a session as held, never as free:
- It reads the first complete JSON object in a file. A file whose pid is alive and whose `sessionId` names the session holds it, however old the file is.
- A file with a dead pid, or a live pid whose start time no longer matches `procStart` (on the Mac, `ps -o lstart` in UTC), holds nothing.
- The `.key` files next to them stay untouched. A process the daemon started itself is never a holder.
- Each daemon reads only its own host's directory, so a pod's daemon reads the pod's.

When the directory is missing, or none of its files has the expected shape, the daemon cannot tell who holds a session and behaves as before these rules: a detached tile shows the `claude --resume` line, and Attach resumes without ending anything.

**Attach.** A detached tile has an Attach button, also a command in the keymap and the palette, and sending a prompt to a detached tile does the same. Attach ends the holder with SIGTERM, then resumes the session in fleet. I want the session in fleet and do not mind what happens in the terminal, VS Code or the Desktop app it came from.
- Before signalling, the daemon checks that the pid still belongs to the process the file describes (its start time matches `procStart`), so a recycled pid is never hit. If it cannot compare the start time, for example on a pod whose format it does not know, it does not signal and asks me to close the process myself.
- A holder whose `kind` is not `interactive` is a background job of Claude Code, whose process may since run another job. It is never signalled: the banner says a background job holds the session, and Attach stays disabled.
- While the holder is busy, the browser asks first.
- If the holder has not exited a few seconds after SIGTERM, the tile shows an error and the session stays detached. No SIGKILL.
- Only I take a session over. A message from another agent to a detached session (`send_message`, the director's messages, a restart note) waits in its queue until the session is back in fleet; it never ends a holder.

**Picking up by itself.** I should not have to go back to fleet and press anything after closing a terminal.
- An import with no holder resumes the session right away.
- While a session is detached, the daemon watches the holder it saw. When that process exits, or its file stops naming the session (after `/clear` or `/resume` there), the daemon resumes the session and adds the turns made elsewhere to the tile's log, as an import does. A tile handed to a terminal waits for the terminal to appear first, so it is not taken straight back. After a daemon restart, a detached session with no holder waits for Attach.
- The detached banner names the holder (a terminal, VS Code or the Desktop app), its cwd and whether it is busy or idle.

**Opened elsewhere.** If I open a session in another client while fleet runs it, without handing it off first, fleet steps back: it ends its own process, shows the tile as detached with the new holder, and picks up again when that holder exits. The daemon therefore watches the session files for its running sessions too, not only for detached ones. A client that restarts a session it lost, as the Desktop app might after Attach, would take it back and forth with fleet; when fleet loses the same session twice within a minute, it stays detached and the banner says why.

**Briefing.** fleet's rules are in the appended system prompt, but an imported conversation grew up in another client, and its history outweighs a system prompt that changed underneath it. So the first turn fleet runs after an import starts with a message telling the agent that it is now fleet worker `<name>` in workspace `<ws>`, that I watch it through the web UI, and that it reaches me through the fleet tools. Whatever I typed follows. Without typed text, as on a pickup, the agent confirms in one line and waits for me. The briefing goes out once per import, so the daemon records it in the event log. A session coming back from a terminal hand-off, the director included, resumes idle; one line saying it is back in fleet goes in front of my next prompt instead of costing a turn. Compaction needs no new briefing, since the system prompt survives it.

**Shared directories.** A new task always gets a workspace of its own, but an imported session stays in the directory it was started in, because Claude Code ties a session to it. So several agents can work in one directory, such as two imported sessions in a project's checkout next to its director. Fleet shows it rather than leaving me to remember: cards and tiles name the workspace an agent works in, the rail lists the agents in each workspace, and the import dialog says "shares sources/2 with alpha, bravo" on a session whose directory other agents already use, before I import it.

**Bringing my own director.** I may already have a Claude Code session that coordinates my work, and fleet's director should start from what it knows. Its conversation is not taken over, since a director needs a clean context and fleet's rules from its first turn. In the import dialog, "Use as director" on a session resumes a fork of it (the SDK's `forkSession`), so the original stays untouched wherever it is open and nothing is ended. The fork gets the handover request and writes the handover file under the director's `.fleet/`. fleet's director then starts a fresh session from that file, as after a handover; its previous session ends. The board and tasks are in the event log and need no handover.

## Security, auth and Mac specifics

The daemon can make agents run commands, so it is reachable only through `127.0.0.1` and tunnels, never an open port.

**Reading files.** The browser asks the daemon for a file's content, never for a path of its own choosing. The daemon reads files inside the agent's workspace and the repos it may read. Outside them it reads only a plan (`plans/`) or a memory file (`projects/*/memory/`) of Claude's config directory that the agent wrote or attached. Paths are resolved through symlinks first, so a link cannot lead out, and nothing under `~/.fleet/secret` or `~/.fleet/remotes` is ever shown, whatever lists it. Attaching a path applies the same rules, so a worker learns at once that fleet will not show a file.

**Network.** Bind to `127.0.0.1`. Remote access from the phone or another machine goes through an ssh tunnel, Coder port forwarding or the VPN; no auth layer of its own in phase 1.

**Claude login.** Personal use on the Team/Max subscription. The SDK sessions run under my own Claude Code login, and the support article on the Agent SDK confirms subscription limits apply to it. Six parallel agents drain limits fast; the monthly API credits included with Max and Team plans are the overflow.

**Permissions.** Agents start in auto mode, with a per-workspace allow list (tests, jj, build). Anything outside goes to the inbox. The director has no write tools outside `.fleet/`.

**Sleep on the Mac.**
- While any agent is busy, the daemon holds `caffeinate -i`.
- Lid-closed mode runs `pmset disablesleep 1` through a sudoers rule that allows exactly `pmset disablesleep 1` and `pmset disablesleep 0`, nothing else.
- It turns itself off when all agents are idle, after 2 h, or below 20 % battery. A banner shows it is on.
- While the lid is closed, builds and benchmarks on the Mac pause; pods keep going.
- The watchdog resumes sessions after network drops (cycling between home and office).

**Coder pods.** Each pod runs its own daemon; the UI on the Mac connects to all of them through tunnels and merges their events. Pods don't sleep, so long jobs go there.

## Build plan

Design happens in chat and on the canvas; code happens in Claude Code, in a new repo with this doc as `docs/design.md` and a short `CLAUDE.md`. Each phase ends with something I use daily.
1. **One agent, better than tmux.** Daemon with one SDK session, event log, reconnecting web view, tile, decision inbox with explanations.
2. **Several agents.** Board, grid, tree, spawn and kill, colors, hosts, unseen marks, CLI bar.
3. **Director.** Custom tools, `spawn_task`, ledger, message bus, flow view, open points.
4. **Review.** Diff view on reviewdiff-core with shared approvals, line threads with agents, small edits via jj.
5. **History and time.** jj orbit embedded, op-log checkpoints, timeline view.
6. **Remote.** Daemons on Coder pods, merged UI, lid-closed mode, watchdog.

**First Claude Code tasks**
- [ ] Spike: SDK session with streaming input, `canUseTool`, one in-process custom tool; confirm subagent messages carry the parent tool-use id
- [ ] Spike: check whether SDK-created sessions resume in the CLI with `claude --resume`
- [ ] Spike: list which slash commands and TUI dialogs have SDK equivalents
- [ ] Event log schema and WebSocket replay
- [ ] Tile component from the mockup, against recorded events
- [ ] Extract reviewdiff-core as a package both ReviewDiff and fleet build from

**Open questions**
- [ ] TypeScript for the daemon (most complete SDK) or Python?
- [ ] One daemon per host, or one daemon on the Mac driving pods over ssh?
- [ ] Do workers on pods share a jj repo with the Mac, or push to GitLab and the director integrates?
- [ ] Where do approvals live when the diff view runs on the Mac and the workspace on a pod?

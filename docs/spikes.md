# Spike findings

Checked against `@anthropic-ai/claude-agent-sdk` 0.3.308.

| Question | Result |
| --- | --- |
| Streaming input, `canUseTool`, resume | Works live: a Bash call reached the inbox, the answer became the tool result, and after a daemon restart `resume` continued the same conversation. |
| Subagent messages carry the parent tool-use id | `parent_tool_use_id` is on assistant and user messages in the SDK types and is stored as the event's `parent`; not yet seen on a live subagent run. |
| In-process custom tools | Work live: the director called `mcp__fleet__spawn_task`, the worker `mcp__fleet__report_result`; a blocking tool can wait for the user (server `timeout` set to a day). |
| SDK sessions resume in the CLI (`claude --resume`) | Yes: a worker session created through the SDK, resumed with `claude -p --resume <id>` in its workspace, remembered what it had done. The "Terminal" button relies on this. |
| Allow lists | Bare names in `allowedTools` (e.g. `Read`) bypass `canUseTool` and make the SDK warn; the daemon approves those itself and passes only pattern rules. |
| Stopping the director from editing code in every permission mode | A `PreToolUse` hook does it: live, the director's `Edit` of a file in its workspace came back as a hook error without a permission prompt, and the file stayed as it was. `canUseTool` alone is not enough, since accept-edits and auto mode never call it for edits. |
| Knowing when a turn is over | The SDK sends `session_state_changed` (`running`, `idle`, `requires_action`) and documents `idle` as the reliable end of a turn, also when prompts sent mid-turn are folded into it. fleet uses it and falls back to `result` messages for CLIs that do not send it. |
| Slash commands and TUI dialogs with SDK equivalents | The init message lists 130+ commands including skills; terminal-only ones (`terminal_slash_commands`) are filtered out. Sent as a prompt, a command runs (`/compact`). Mode, model, interrupt and context usage have SDK methods (`setPermissionMode`, `setModel`, `interrupt`, `getContextUsage`); network trouble arrives as `api_retry` messages. Commands that open TUI dialogs (`/config`, `/agents`, `/mcp`) have no browser equivalent yet. |

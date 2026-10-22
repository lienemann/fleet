# Spike findings

Checked against `@anthropic-ai/claude-agent-sdk` 0.3.308.

| Question | Result |
| --- | --- |
| Streaming input, `canUseTool`, resume | Works live: a Bash call reached the inbox, the answer became the tool result, and after a daemon restart `resume` continued the same conversation. |
| Subagent messages carry the parent tool-use id | `parent_tool_use_id` is on assistant and user messages in the SDK types and is stored as the event's `parent`; not yet seen on a live subagent run. |
| In-process custom tools | Work live: the director called `mcp__fleet__spawn_task`, the worker `mcp__fleet__report_result`; a blocking tool can wait for the user (server `timeout` set to a day). |
| SDK sessions resume in the CLI (`claude --resume`) | Not checked. |
| Allow lists | Bare names in `allowedTools` (e.g. `Read`) bypass `canUseTool` and make the SDK warn; the daemon approves those itself and passes only pattern rules. |
| Slash commands and TUI dialogs with SDK equivalents | Not checked. The SDK has `setPermissionMode`, `setModel`, `interrupt` and `api_retry` messages, which cover the phase 2 CLI bar. |

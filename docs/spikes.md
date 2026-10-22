# Spike findings

Checked against `@anthropic-ai/claude-agent-sdk` 0.3.308.

| Question | Result |
| --- | --- |
| Streaming input, `canUseTool`, resume | Works live: a Bash call reached the inbox, the answer became the tool result, and after a daemon restart `resume` continued the same conversation. |
| Subagent messages carry the parent tool-use id | `parent_tool_use_id` is on assistant and user messages in the SDK types and is stored as the event's `parent`; not yet seen on a live subagent run. |
| In-process custom tool | Not done yet (phase 3). `tool()` and `createSdkMcpServer()` exist. |
| SDK sessions resume in the CLI (`claude --resume`) | Not checked. |
| Slash commands and TUI dialogs with SDK equivalents | Not checked. The SDK has `setPermissionMode`, `setModel`, `interrupt` and `api_retry` messages, which cover the phase 2 CLI bar. |

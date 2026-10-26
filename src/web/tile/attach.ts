import type { SessionHolder } from "../../shared/events.ts";
import type { Command } from "../../shared/protocol.ts";
import type { AgentView } from "../../shared/reducer.ts";

const CLIENTS: Record<SessionHolder["client"], string> = {
  terminal: "a terminal",
  vscode: "VS Code",
  desktop: "the Desktop app",
  other: "another client",
};

/** "a terminal", "VS Code", "the Desktop app" */
export const holderLabel = (holder: SessionHolder): string => CLIENTS[holder.client];

/** Whether Attach ends the holder: never a background job or a process fleet cannot confirm. */
export const endsHolder = (holder: SessionHolder | null | undefined): holder is SessionHolder =>
  Boolean(holder && !holder.background && holder.verified);

/** Asks first while the client that Attach would end is in the middle of a turn. */
export function confirmTakeover(agent: AgentView): boolean {
  const holder = agent.holder;
  if (!endsHolder(holder) || !holder.busy) return true;
  const label = holderLabel(holder);
  return confirm(
    `${label[0]?.toUpperCase()}${label.slice(1)} is in the middle of a turn. End it and run ${agent.name} in fleet?`,
  );
}

/** Ends the client that holds a detached session and runs it in fleet. */
export function attachAgent(agent: AgentView, send: (message: Command) => void): void {
  if (confirmTakeover(agent)) send({ type: "attach", agent: agent.name });
}

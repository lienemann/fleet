import { forkSession } from "@anthropic-ai/claude-agent-sdk";

/**
 * Forks a stored session of directory `dir` and returns the fork's id. Claude Code finds the
 * fork when another directory resumes it, so a worker elsewhere continues the conversation.
 */
export async function forkConversation(sessionId: string, dir: string): Promise<string> {
  return (await forkSession(sessionId, { dir })).sessionId;
}

/** The first prompt of a task's conversation that continues where it stopped. */
export const continueTask = (task: string): string =>
  `You take task ${task} up again. Carry on where you left off.`;

/** Goes in front of the first prompt of a conversation that moved to another worker. */
export const movedBriefing = (move: {
  task: string;
  worker: string;
  workspace: string;
  from: string;
  cwd: string;
}): string =>
  `You continue task ${move.task} as ${move.worker} in workspace ${move.workspace}. ` +
  `Your earlier turns ran in ${move.from}, which belongs to another worker now: ` +
  `read and write only under ${move.cwd}.`;

/** A first prompt on a task, followed by the handover note it was parked with, if any. */
export const withNote = (prompt: string, note?: string): string =>
  note ? `${prompt}\n\nHandover note from the last worker:\n\n${note}` : prompt;

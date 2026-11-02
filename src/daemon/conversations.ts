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

/** Tells a guest whose conversation moved into a workspace that it is that workspace's worker now. */
export const madeWorkerBriefing = (move: {
  worker: string;
  workspace: string;
  from: string;
  cwd: string;
}): string =>
  `You are now ${move.worker}, the fleet worker of workspace ${move.workspace}, and this ` +
  `conversation continues there. Your earlier turns ran in ${move.from}, which you no longer ` +
  `share; what you changed there stays there. Read and write only under ${move.cwd}. From now ` +
  `on fleet gives you tasks like any worker. Confirm in one line, then wait.`;

/** Follows the briefing of an imported session whose fork goes on in another directory. */
export const forkedImportNote = (from: string, cwd: string): string =>
  `Your earlier turns ran in ${from}, where another worker is busy; the session there stays as ` +
  `it was, and you continue a copy of it. Read and write only under ${cwd}.`;

/** A first prompt on a task, followed by the handover note it was parked with, if any. */
export const withNote = (prompt: string, note?: string): string =>
  note ? `${prompt}\n\nHandover note from the last worker:\n\n${note}` : prompt;

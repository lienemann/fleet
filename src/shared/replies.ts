import type { Decision, FinishedRun, Message } from "./reducer.ts";

/** Characters of an item's first line that a reference quotes. */
export const QUOTE_CHARS = 120;

const pad = (n: number): string => String(n).padStart(2, "0");

/** "14:05", in the local time of whoever writes the reference. */
const clock = (ts: number): string => {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** The first line that says something, cut to QUOTE_CHARS. */
function quoteOf(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > QUOTE_CHARS ? `${line.slice(0, QUOTE_CHARS - 1)}…` : line;
}

/**
 * What an agent reads above a comment from the inbox, so it knows what the comment answers:
 * "Re: your closing message of 14:20 on t23:", and the item's first line quoted below it.
 */
function reference(what: string, at: number, task: string | undefined, text: string): string {
  const on = task === undefined ? "" : ` on ${task}`;
  const quote = quoteOf(text);
  return `Re: ${what} of ${clock(at)}${on}:${quote && `\n> ${quote}`}`;
}

export const runReference = (run: FinishedRun): string =>
  reference(
    run.stopped === undefined ? "your closing message" : "your last message before you stopped",
    run.endedAt,
    run.task,
    run.text,
  );

export const messageReference = (message: Message): string =>
  reference("your message", message.ts, message.task, message.body);

/** `task` is the one the agent holds while it waits for the decision. */
export function decisionReference(decision: Decision, task?: string): string {
  if (decision.decision === "question") {
    return reference("your question", decision.ts, task, decisionSubject(decision));
  }
  if (decision.toolName === "ExitPlanMode") {
    const plan = decision.input.plan;
    return reference("your plan", decision.ts, task, typeof plan === "string" ? plan : "");
  }
  return reference(`your ${decision.toolName} call`, decision.ts, task, decisionSubject(decision));
}

/** A comment with the reference to what it answers above it. */
export const withReference = (reference: string, comment: string): string =>
  `${reference}\n\n${comment}`;

/** What a decision is about, in one line where possible: the command, the question, the file. */
export function decisionSubject(decision: Decision): string {
  if (decision.decision === "review") return decision.path ?? "";
  if (decision.decision === "question") {
    const questions = decision.questions ?? [];
    return questions.length === 1
      ? (questions[0]?.question ?? "")
      : `${questions.length} questions`;
  }
  // Leaving plan mode is approving the plan written just above.
  if (decision.toolName === "ExitPlanMode") return "Approve the plan above and start working";
  const command = decision.input.command ?? decision.input.file_path ?? decision.input.url;
  return typeof command === "string" ? command : JSON.stringify(decision.input, null, 2);
}

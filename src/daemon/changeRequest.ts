import type { LineThread, ReviewEdit, ThreadMessage } from "../shared/review.ts";

/** The thread's quote; a selection longer than the quote says how many lines it leaves out. */
function quoted({ quote, lines }: LineThread): string {
  const text = quote.map((line) => `   > ${line}`).join("\n");
  const rest = lines.endExclusive - lines.start - quote.length;
  return rest > 0 ? `${text}\n   … ${rest} more ${rest === 1 ? "line" : "lines"}` : text;
}

/** "lib.py:2-3" for the head side, "lib.py, old lines 4-6" for the base side. */
function place({ path, side, lines }: LineThread): string {
  const last = lines.endExclusive - 1;
  const range = last > lines.start ? `${lines.start}-${last}` : `${lines.start}`;
  if (side === "head") return `${path}:${range}`;
  return `${path}, old ${last > lines.start ? "lines" : "line"} ${range}`;
}

function editsBlock(edits: ReviewEdit[]): string {
  const items = edits.map((e) => {
    const lines = [...e.before.map((l) => `  - ${l}`), ...e.after.map((l) => `  + ${l}`)];
    return `- ${e.path} (${e.commit}):\n${lines.join("\n")}`;
  });
  return `I edited these lines myself; keep my version:\n\n${items.join("\n")}`;
}

/** One message of a thread, sent at once: the quoted lines, the question and the user's pending edits. */
export function threadMessage(
  thread: LineThread,
  message: ThreadMessage,
  edits: ReviewEdit[],
): string {
  const from = thread.commit ? ` (from commit ${thread.commit})` : "";
  const parts = [
    `About ${place(thread)}${from}, thread ${thread.id}:\n${quoted(thread)}`,
    message.body,
  ];
  if (message.fold) {
    parts.push(
      `If you change these lines, fold the change into commit ${message.fold} (for example \`jj squash --into ${message.fold}\`), so the history reads as if it had been right from the start.`,
    );
  }
  parts.push(`Answer with the reply_thread tool, thread "${thread.id}".`);
  if (edits.length > 0) parts.push(editsBlock(edits));
  return parts.join("\n\n");
}

/** The one message "Request changes" sends: the user's note, the held thread messages with quoted code, and the user's edits. */
export function changeRequest(
  draft: { threads: LineThread[]; edits: ReviewEdit[] },
  note?: string,
): string {
  const parts: string[] = [];
  if (note?.trim()) parts.push(note.trim());
  const held = draft.threads.flatMap((thread) =>
    thread.messages.filter((m) => m.held).map((message) => ({ thread, message })),
  );
  if (held.length > 0) {
    const items = held.map(({ thread, message }, i) => {
      const fold = message.fold
        ? `\n   Fold the change into commit ${message.fold} (for example \`jj squash --into ${message.fold}\`).`
        : "";
      return `${i + 1}. ${place(thread)}, thread ${thread.id}\n${quoted(thread)}\n   ${message.body.replaceAll("\n", "\n   ")}${fold}`;
    });
    parts.push(
      `${items.join("\n\n")}\n\nAnswer each with the reply_thread tool and its thread id.`,
    );
  }
  if (draft.edits.length > 0) parts.push(editsBlock(draft.edits));
  return parts.length > 0 ? parts.join("\n\n") : "Please revise your change.";
}

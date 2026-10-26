import type { ReviewComment, ReviewEdit } from "../shared/review.ts";

/** The one message "Request changes" sends: the user's note, the comments with quoted code, and the user's edits. */
export function changeRequest(
  comments: ReviewComment[],
  edits: ReviewEdit[],
  note?: string,
): string {
  const parts: string[] = [];
  if (note?.trim()) parts.push(note.trim());
  if (comments.length > 0) {
    const items = comments.map((c, i) => {
      const quote = c.quote
        .split("\n")
        .map((line) => `   > ${line}`)
        .join("\n");
      return `${i + 1}. ${c.path}:${c.line}\n${quote}\n   ${c.body.replaceAll("\n", "\n   ")}`;
    });
    parts.push(`Review comments:\n\n${items.join("\n\n")}`);
  }
  if (edits.length > 0) {
    const items = edits.map((e) => {
      const lines = [...e.before.map((l) => `  - ${l}`), ...e.after.map((l) => `  + ${l}`)];
      return `- ${e.path} (${e.commit}):\n${lines.join("\n")}`;
    });
    parts.push(`I edited these lines myself; keep my version:\n\n${items.join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : "Please revise your change.";
}

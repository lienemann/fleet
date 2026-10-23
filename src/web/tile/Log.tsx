import { useEffect, useRef } from "react";
import type { LogLine } from "../../shared/reducer.ts";
import { Markdown } from "../ui/Markdown.tsx";

export type LogFilter = "all" | "main" | "subagents";

export const LOG_FILTERS: LogFilter[] = ["all", "main", "subagents"];

const visible = (line: LogLine, filter: LogFilter): boolean =>
  filter === "all" || (filter === "main") === (line.parent === null);

/** The transcript, anchored at the bottom unless the user scrolled up to read. */
export function Log({ lines, filter }: { lines: LogLine[]; filter: LogFilter }) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const shown = lines.filter((line) => visible(line, filter));
  const last = shown.at(-1)?.seq;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new last line is the trigger
  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <div
      className="log"
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {shown.map((line) => (
        <div key={line.seq} className={`line ${line.role} ${line.parent ? "sub" : ""}`}>
          {line.toolName && <span className="toolname">{line.toolName}</span>}
          {line.role === "assistant" ? (
            <Markdown text={line.text} className="text" />
          ) : (
            <span className="text">{line.text}</span>
          )}
          {line.truncated && <span className="truncated"> …</span>}
        </div>
      ))}
    </div>
  );
}

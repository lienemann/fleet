import { useCallback, useState } from "react";
import { useFleet } from "../fleet.tsx";
import { Markdown } from "../ui/Markdown.tsx";

/** A prompt that asks a side question instead of talking to the session. */
const BTW = /^\/btw\s+(\S[\s\S]*)$/;

interface Entry {
  question: string;
  answer?: string;
  error?: string;
}

/**
 * Side questions about a session, like /btw in the CLI: Claude answers from what the session
 * knows, and neither the question nor the answer goes into it.
 */
export function useSideChat(agent: string) {
  const { call } = useFleet();
  const [entries, setEntries] = useState<Entry[]>([]);

  /** Asks if `text` is a side question; false lets the caller send it as a prompt. */
  const ask = useCallback(
    (text: string): boolean => {
      const question = BTW.exec(text.trim())?.[1];
      if (!question) return false;
      const entry: Entry = { question };
      const settle = (done: Entry) => setEntries((all) => all.map((e) => (e === entry ? done : e)));
      setEntries((all) => [...all, entry]);
      call({ type: "side_question", agent, question }).then(
        (answer) => settle({ question, answer: answer || "No answer." }),
        (error: Error) => settle({ question, error: error.message || "The question failed." }),
      );
      return true;
    },
    [call, agent],
  );

  return { entries, ask, close: () => setEntries([]) };
}

export function SideChat({ entries, onClose }: { entries: Entry[]; onClose: () => void }) {
  if (entries.length === 0) return null;
  return (
    <aside className="side-chat" aria-label="Side questions">
      <div className="side-chat-head">
        <span className="dim">Side questions · not added to the session</span>
        <button type="button" className="link dim" onClick={onClose}>
          Close
        </button>
      </div>
      {entries.map((entry, i) => (
        // Entries are only ever appended, so the index is stable.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={i} className="side-entry">
          <p className="side-question">› {entry.question}</p>
          {entry.error !== undefined ? (
            <p className="dim">{entry.error}</p>
          ) : entry.answer === undefined ? (
            <p className="dim">Thinking…</p>
          ) : (
            <Markdown text={entry.answer} />
          )}
        </div>
      ))}
    </aside>
  );
}

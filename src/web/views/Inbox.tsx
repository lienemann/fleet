import { useState } from "react";
import { USER } from "../../shared/events.ts";
import { type OpenPointsDoc, openPointDocs, pendingDecisions } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { useShownState } from "../projects.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";

/** Answers most open points get; anything else is typed. */
const QUICK_ANSWERS = ["Yes", "No", "Defer"];

/** Everything waiting on the user: decisions and permissions, open points, and messages to them. */
export function Inbox({ onOpen }: { onOpen: (agent: string) => void }) {
  const { send, state: all } = useFleet();
  const state = useShownState();
  const items = pendingDecisions(state);
  const docs = openPointDocs(state);
  const forMe = state.messages
    .filter((m) => m.to === USER)
    .slice(-10)
    .reverse();
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(0, items.length - 1));
  const focused = items[index];
  const answer = (behavior: "allow" | "deny") =>
    focused && send({ type: "answer", requestId: focused.requestId, answer: { behavior } });

  // While the inbox is shown, j/k walk its decisions and a/r answer the focused one.
  const inboxCommand = { group: "Inbox", priority: 1 };
  useCommands([
    {
      ...inboxCommand,
      id: "inbox.next",
      label: "Next decision",
      keys: ["j"],
      paletteHidden: true,
      run: () => setCursor(Math.min(index + 1, items.length - 1)),
    },
    {
      ...inboxCommand,
      id: "inbox.previous",
      label: "Previous decision",
      keys: ["k"],
      paletteHidden: true,
      run: () => setCursor(Math.max(index - 1, 0)),
    },
    {
      ...inboxCommand,
      id: "inbox.approve",
      label: "Approve the focused permission",
      keys: ["a"],
      run: () => focused?.decision === "permission" && answer("allow"),
    },
    {
      ...inboxCommand,
      id: "inbox.reject",
      label: "Reject the focused permission",
      keys: ["r"],
      run: () => focused?.decision === "permission" && answer("deny"),
    },
    {
      ...inboxCommand,
      id: "inbox.open",
      label: "Open the focused decision's agent",
      keys: ["o", "enter"],
      run: () => focused && onOpen(focused.agent),
    },
  ]);

  return (
    <div className="inbox">
      {items.length === 0 && docs.length === 0 && (
        <p className="empty-box">Nothing waits on you. Agents keep working.</p>
      )}
      {items.map((decision) => (
        <DecisionCard
          key={decision.requestId}
          decision={decision}
          agent={all.agents[decision.agent]}
          onOpen={() => onOpen(decision.agent)}
          focused={decision === focused}
          onAnswer={(a) => send({ type: "answer", requestId: decision.requestId, answer: a })}
        />
      ))}
      {docs.length > 0 && (
        <section>
          <h2>
            Open points{" "}
            <span className="lede">
              · from the Markdown files agents wrote for you; the answers go back together
            </span>
          </h2>
          {docs.map((doc) => (
            <OpenPoints key={doc.docId} doc={doc} />
          ))}
        </section>
      )}
      {forMe.length > 0 && (
        <section>
          <h2>Messages for you</h2>
          {forMe.map((message) => (
            <MessageItem key={message.seq} message={message} onOpen={onOpen} />
          ))}
        </section>
      )}
    </div>
  );
}

function OpenPoints({ doc }: { doc: OpenPointsDoc }) {
  const { state, send, color } = useFleet();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const open = doc.points.filter((p) => p.answer === undefined);
  return (
    <article className="decision points">
      <header>
        <strong
          className="name"
          style={{ color: color(state.agents[doc.agent]?.color ?? "#888888") }}
        >
          {doc.agent}
        </strong>
        <code className="name">{doc.path}</code>
        <span className="dim">
          {doc.points.length - open.length}/{doc.points.length} answered
        </span>
      </header>
      {doc.points.map((point) => {
        const answer = (text: string) =>
          send({ type: "answer_point", docId: doc.docId, pointId: point.id, answer: text });
        return (
          <form
            key={point.id}
            className="point"
            onSubmit={(event) => {
              event.preventDefault();
              const draft = drafts[point.id]?.trim();
              if (draft) answer(draft);
            }}
          >
            <span>{point.text}</span>
            {point.answer === undefined ? (
              <div className="point-answer">
                {QUICK_ANSWERS.map((quick) => (
                  <button key={quick} type="button" className="small" onClick={() => answer(quick)}>
                    {quick}
                  </button>
                ))}
                <input
                  aria-label={`Answer to: ${point.text}`}
                  value={drafts[point.id] ?? ""}
                  onChange={(e) => setDrafts({ ...drafts, [point.id]: e.target.value })}
                  placeholder="or write an answer"
                />
                <button
                  type="submit"
                  className="small primary"
                  disabled={!drafts[point.id]?.trim()}
                >
                  Answer
                </button>
              </div>
            ) : (
              <span className="answered">✓ {point.answer}</span>
            )}
          </form>
        );
      })}
    </article>
  );
}

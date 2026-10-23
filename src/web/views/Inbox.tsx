import { useState } from "react";
import { USER } from "../../shared/events.ts";
import { type OpenPointsDoc, openPointDocs, pendingDecisions } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";

/** Everything waiting on the user: decisions and permissions, open points, and messages to them. */
export function Inbox({ onOpen }: { onOpen: (agent: string) => void }) {
  const { state, send, color } = useFleet();
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
      <section>
        <h2>Decisions and permissions · {items.length}</h2>
        {items.length === 0 && <p className="empty">Nothing waits on you.</p>}
        {items.map((decision) => (
          <DecisionCard
            key={decision.requestId}
            decision={decision}
            agentColor={color(state.agents[decision.agent]?.color ?? "#888888")}
            focused={decision === focused}
            onAnswer={(a) => send({ type: "answer", requestId: decision.requestId, answer: a })}
          />
        ))}
      </section>
      {docs.length > 0 && (
        <section>
          <h2>Open points</h2>
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
          {doc.points.length - open.length}/{doc.points.length} answered; the answers go back
          together
        </span>
      </header>
      {doc.points.map((point) => (
        <form
          key={point.id}
          className="point"
          onSubmit={(event) => {
            event.preventDefault();
            const answer = drafts[point.id]?.trim();
            if (answer) send({ type: "answer_point", docId: doc.docId, pointId: point.id, answer });
          }}
        >
          <span>{point.text}</span>
          {point.answer === undefined ? (
            <>
              <input
                value={drafts[point.id] ?? ""}
                onChange={(e) => setDrafts({ ...drafts, [point.id]: e.target.value })}
                placeholder="Your answer"
              />
              <button type="submit" className="small" disabled={!drafts[point.id]?.trim()}>
                Answer
              </button>
            </>
          ) : (
            <span className="dim">→ {point.answer}</span>
          )}
        </form>
      ))}
    </article>
  );
}

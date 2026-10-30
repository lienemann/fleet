import { useState } from "react";
import { USER } from "../../shared/events.ts";
import {
  type OpenPointsDoc,
  openPointDocs,
  pendingDecisions,
  unreadFinished,
  unreadThreads,
} from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { useShownState } from "../projects.tsx";
import { threadPlace } from "../review/Thread.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";
import { FinishedGroup, ReadRuns } from "./FinishedRuns.tsx";

/** Answers most open points get; anything else is typed. */
const QUICK_ANSWERS = ["Yes", "No", "Defer"];

/** Lines of a reply the inbox shows before the diff has the rest. */
const REPLY_LINES = 3;

/** Everything waiting on the user: decisions and permissions, open points, replies and messages. */
export function Inbox({
  onOpen,
  onOpenThread,
}: {
  onOpen: (agent: string) => void;
  onOpenThread: (agent: string, thread: string) => void;
}) {
  const { send, state: all, color } = useFleet();
  const state = useShownState();
  const items = pendingDecisions(state);
  const docs = openPointDocs(state);
  const replies = unreadThreads(state);
  const finished = unreadFinished(state);
  const forMe = state.messages
    .filter((m) => m.to === USER)
    .slice(-10)
    .reverse();
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(0, items.length - 1));
  const focused = items[index];
  // The group last worked in, which the palette's command marks read.
  const [lastGroup, setLastGroup] = useState<string>();
  const group = finished.find((g) => g.agent === lastGroup) ?? finished[0];
  const answer = (behavior: "allow" | "deny") =>
    focused && send({ type: "answer", requestId: focused.requestId, answer: { behavior } });

  // While the focus is in the inbox, j/k walk its decisions and ⌥A/⌥R answer the focused one.
  const inboxCommand = { group: "Inbox", scope: "main" } as const;
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
      keys: ["alt+a"],
      run: () => focused?.decision === "permission" && answer("allow"),
    },
    {
      ...inboxCommand,
      id: "inbox.reject",
      label: "Reject the focused permission",
      keys: ["alt+r"],
      run: () => focused?.decision === "permission" && answer("deny"),
    },
    {
      ...inboxCommand,
      id: "inbox.open",
      label: "Open the focused decision's agent",
      keys: ["alt+o", "enter"],
      run: () => focused && onOpen(focused.agent),
    },
    {
      ...inboxCommand,
      id: "inbox.finished.read",
      label: "Mark the focused agent's finished runs read",
      run: () =>
        group &&
        send({
          type: "finished_read",
          agent: group.agent,
          ids: group.runs.map((run) => run.id),
        }),
    },
  ]);

  return (
    <div className="inbox">
      {items.length === 0 && docs.length === 0 && replies.length === 0 && finished.length === 0 && (
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
      {finished.length > 0 && (
        <section>
          <h2>
            Finished <span className="lede">· how runs you started ended</span>
          </h2>
          {finished.map(({ agent, runs }) => {
            const view = state.agents[agent];
            return (
              view && (
                <FinishedGroup
                  key={agent}
                  agent={view}
                  runs={runs}
                  onOpen={() => onOpen(agent)}
                  onFocus={() => setLastGroup(agent)}
                />
              )
            );
          })}
        </section>
      )}
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
      {replies.length > 0 && (
        <section>
          <h2>
            Replies <span className="lede">· answers under the lines you asked about</span>
          </h2>
          {replies.map(({ agent, thread }) => (
            <article key={thread.id} className="decision reply">
              <header>
                <strong
                  className="name"
                  style={{ color: color(all.agents[agent]?.color ?? "#888888") }}
                >
                  {agent}
                </strong>
                <code className="name">{threadPlace(thread.path, thread.side, thread.lines)}</code>
              </header>
              <p className="reply-text">
                {(thread.messages.at(-1)?.body ?? "").split("\n").slice(0, REPLY_LINES).join("\n")}
              </p>
              <footer>
                <button
                  type="button"
                  className="small"
                  onClick={() => onOpenThread(agent, thread.id)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() => send({ type: "thread_read", agent, threadId: thread.id })}
                >
                  Mark read
                </button>
              </footer>
            </article>
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
      <ReadRuns onOpen={onOpen} />
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

import { useState } from "react";
import { type OpenPointsDoc, openPointDocs, pendingDecisions } from "../../shared/reducer.ts";
import { lastAgentOf, unreadThreads } from "../../shared/tasks.ts";
import { itemSlot, useAgentDraft } from "../drafts.ts";
import { useFleet } from "../fleet.tsx";
import { groupIds, inboxGroups } from "../inboxItems.ts";
import { useCommands } from "../keys/keymap.tsx";
import { useShownState } from "../projects.tsx";
import { threadPlace } from "../review/Thread.tsx";
import { AgentLabel, OpenAgentProvider } from "../ui/AgentLabel.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { ItemActions } from "../ui/ItemActions.tsx";
import { Options } from "../ui/Options.tsx";
import { TaskHead } from "../ui/TaskHead.tsx";
import { FinishedGroup, ReadItems } from "./FinishedRuns.tsx";

/** Answers most open points get; anything else is typed. */
const QUICK_ANSWERS = ["Yes", "No", "Defer"].map((label) => ({ label }));

/** Lines of a reply the inbox shows before the diff has the rest. */
const REPLY_LINES = 3;

/**
 * Everything waiting on the user: decisions and permissions, each agent's Finished items and
 * messages, open points and replies. An agent's name on any item opens the agent.
 */
export function Inbox({
  onOpen,
  onOpenTab,
  onOpenThread,
}: {
  onOpen: (agent: string) => void;
  onOpenTab: (agent: string, tab: "diff" | "report") => void;
  /** Opens a task's diff at one of its threads. */
  onOpenThread: (task: string, thread: string) => void;
}) {
  const { send, state: all } = useFleet();
  const state = useShownState();
  const items = pendingDecisions(state);
  const docs = openPointDocs(state);
  const replies = unreadThreads(state);
  const groups = inboxGroups(state);
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(0, items.length - 1));
  const focused = items[index];
  // The group last worked in, which the palette's command marks read.
  const [lastGroup, setLastGroup] = useState<string>();
  const group = groups.find((g) => g.agent === lastGroup) ?? groups[0];
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
      label: "Mark the focused agent's runs and messages read",
      run: () => {
        if (!group) return;
        const { ids, seqs } = groupIds(group);
        send(
          ids.length > 0
            ? { type: "finished_read", agent: group.agent, ids }
            : { type: "messages_read", agent: group.agent, seqs },
        );
      },
    },
  ]);

  return (
    <OpenAgentProvider value={onOpen}>
      <div className="inbox">
        {items.length === 0 && docs.length === 0 && replies.length === 0 && groups.length === 0 && (
          <p className="empty-box">Nothing waits on you. Agents keep working.</p>
        )}
        {items.map((decision) => (
          <DecisionCard
            key={decision.requestId}
            decision={decision}
            agent={all.agents[decision.agent]}
            focused={decision === focused}
            onAnswer={(a) => send({ type: "answer", requestId: decision.requestId, answer: a })}
          />
        ))}
        {groups.length > 0 && (
          <section>
            <h2>
              Finished and messages{" "}
              <span className="lede">· how runs you started ended, and what agents wrote you</span>
            </h2>
            {groups.map((g) => {
              const view = state.agents[g.agent];
              return (
                view && (
                  <FinishedGroup
                    key={g.agent}
                    agent={view}
                    group={g}
                    active={group?.agent === g.agent}
                    onOpenTab={(tab) => onOpenTab(g.agent, tab)}
                    onFocus={() => setLastGroup(g.agent)}
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
            {replies.map(({ task, thread }) => (
              <article key={thread.id} className="decision reply">
                <header>
                  <ReplyFrom task={task} />
                  <code className="name">
                    {threadPlace(thread.path, thread.side, thread.lines)}
                  </code>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="link accent"
                    onClick={() => onOpenThread(task, thread.id)}
                  >
                    Thread
                  </button>
                </header>
                <p className="reply-text">
                  {(thread.messages.at(-1)?.body ?? "")
                    .split("\n")
                    .slice(0, REPLY_LINES)
                    .join("\n")}
                </p>
                <ItemActions
                  actions={[
                    {
                      label: "Mark read",
                      tone: "primary",
                      run: () => send({ type: "thread_read", task, threadId: thread.id }),
                    },
                  ]}
                />
              </article>
            ))}
          </section>
        )}
        <ReadItems />
      </div>
    </OpenAgentProvider>
  );
}

function OpenPoints({ doc }: { doc: OpenPointsDoc }) {
  const open = doc.points.filter((p) => p.answer === undefined);
  return (
    <article className="decision points">
      <header>
        <AgentLabel agent={doc.agent} />
        <code className="name">{doc.path}</code>
        <span className="dim">
          {doc.points.length - open.length}/{doc.points.length} answered
        </span>
      </header>
      {doc.points.map((point) => (
        <PointForm key={point.id} doc={doc} point={point} />
      ))}
    </article>
  );
}

function PointForm({ doc, point }: { doc: OpenPointsDoc; point: OpenPointsDoc["points"][number] }) {
  const { send } = useFleet();
  const [draft, setDraft] = useAgentDraft(doc.agent, itemSlot.point(doc.docId, point.id));
  const answer = (text: string) => {
    send({ type: "answer_point", docId: doc.docId, pointId: point.id, answer: text });
    setDraft("");
  };
  const submit = () => draft.trim() && answer(draft.trim());
  return (
    <form
      className="point"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span>{point.text}</span>
      {point.answer === undefined ? (
        <>
          <Options choices={QUICK_ANSWERS} onPick={answer} />
          <input
            className="other"
            aria-label={`Answer to: ${point.text}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="or write an answer"
          />
          <ItemActions
            actions={[{ label: "Answer", tone: "primary", disabled: !draft.trim(), run: submit }]}
          />
        </>
      ) : (
        <span className="answered">✓ {point.answer}</span>
      )}
    </form>
  );
}

/** Who a reply comes from: the task's agent, or the task itself once nobody holds it. */
function ReplyFrom({ task }: { task: string }) {
  const { state } = useFleet();
  const view = state.tasks[task];
  const agent = view && lastAgentOf(state, view);
  return <TaskHead task={task} agent={agent} />;
}

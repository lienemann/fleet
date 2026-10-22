import { useState } from "react";
import type { ClientMessage } from "../shared/protocol.ts";
import { type FleetState, pendingDecisions } from "../shared/reducer.ts";
import { DecisionCard } from "./DecisionCard.tsx";
import { useHotkeys } from "./useHotkeys.ts";

interface Props {
  state: FleetState;
  send: (message: ClientMessage) => void;
  onOpen: (agent: string) => void;
}

export function Inbox({ state, send, onOpen }: Props) {
  const items = pendingDecisions(state);
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(0, items.length - 1));
  const focused = items[index];

  useHotkeys({
    j: () => setCursor(Math.min(index + 1, items.length - 1)),
    k: () => setCursor(Math.max(index - 1, 0)),
    a: () =>
      focused &&
      send({ type: "answer", requestId: focused.requestId, answer: { behavior: "allow" } }),
    r: () =>
      focused &&
      send({ type: "answer", requestId: focused.requestId, answer: { behavior: "deny" } }),
    Enter: () => focused && onOpen(focused.agent),
  });

  if (items.length === 0) {
    return <p className="empty">Nothing waits on you.</p>;
  }
  return (
    <section className="inbox">
      <h2>Decisions and permissions</h2>
      {items.map((decision) => (
        <DecisionCard
          key={decision.requestId}
          decision={decision}
          agentColor={state.agents[decision.agent]?.color}
          focused={decision === focused}
          onAnswer={(answer) => send({ type: "answer", requestId: decision.requestId, answer })}
        />
      ))}
    </section>
  );
}

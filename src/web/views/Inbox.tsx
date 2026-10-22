import { useState } from "react";
import { pendingDecisions } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { DecisionCard } from "../ui/DecisionCard.tsx";
import { useHotkeys } from "../useHotkeys.ts";

/** What waits on me? Decisions and permissions, oldest first. */
export function Inbox({ onOpen }: { onOpen: (agent: string) => void }) {
  const { state, send, color } = useFleet();
  const items = pendingDecisions(state);
  const [cursor, setCursor] = useState(0);
  const index = Math.min(cursor, Math.max(0, items.length - 1));
  const focused = items[index];
  const answer = (behavior: "allow" | "deny") =>
    focused && send({ type: "answer", requestId: focused.requestId, answer: { behavior } });

  useHotkeys({
    j: () => setCursor(Math.min(index + 1, items.length - 1)),
    k: () => setCursor(Math.max(index - 1, 0)),
    a: () => focused?.decision === "permission" && answer("allow"),
    r: () => answer("deny"),
    enter: () => focused && onOpen(focused.agent),
  });

  if (items.length === 0) return <p className="empty">Nothing waits on you.</p>;
  return (
    <section className="inbox">
      <h2>Decisions and permissions</h2>
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
  );
}

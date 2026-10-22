import type { Message } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";

/** One message between agents: sender, recipient and the Markdown body as written. */
export function MessageItem({
  message,
  onOpen,
}: {
  message: Message;
  onOpen?: (agent: string) => void;
}) {
  const { state, color } = useFleet();
  const name = (agent: string) => (
    <button
      type="button"
      className="link agent-name"
      style={{ color: color(state.agents[agent]?.color ?? "#888888") }}
      disabled={!state.agents[agent] || !onOpen}
      onClick={() => onOpen?.(agent)}
    >
      {agent}
    </button>
  );
  return (
    <article className="message">
      <header>
        {name(message.from)} → {name(message.to)}
        <time className="dim">{new Date(message.ts).toLocaleTimeString()}</time>
      </header>
      <pre>{message.body}</pre>
    </article>
  );
}

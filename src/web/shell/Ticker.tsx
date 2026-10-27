import { useFleet } from "../fleet.tsx";
import { ago } from "../labels.ts";
import { projectsOf } from "../projects.tsx";
import { useNow } from "../useNow.ts";
import { LIVE_MS } from "../views/Flow.tsx";

/**
 * The message bus: the last two messages between agents, newest first, each with a dot on its
 * wire. A new message's dot crosses three times, then rests at the recipient.
 */
export function Ticker() {
  const { state, color } = useFleet();
  const now = useNow(1000);
  const recent = state.messages.slice(-2).reverse();
  const tint = (agent: string) => color(state.agents[agent]?.color ?? "#888888");
  return (
    <div className="ticker">
      <span className="label">Bus</span>
      {recent.length === 0 && <span className="dim">No messages yet.</span>}
      {recent.map((message) => {
        const [first = "", ...rest] = message.body.split("\n");
        // A message between two projects names both.
        const ends = projectsOf(state, message);
        return (
          <span key={message.seq} className="ticker-item">
            <span className="name" style={{ color: tint(message.from) }}>
              {message.from}
            </span>
            {ends && <span className="project-chip">{ends[0]}</span>}
            <span className="wire" aria-hidden="true">
              <span
                className={now - message.ts < LIVE_MS ? "packet live" : "packet"}
                style={{ background: tint(message.from) }}
              />
            </span>
            <span className="name" style={{ color: tint(message.to) }}>
              {message.to}
            </span>
            {ends && <span className="project-chip">{ends[1]}</span>}
            <span className="ticker-body">{first}</span>
            {rest.length > 0 && <span className="dim">+{rest.length} lines</span>}
            <span className="dim">{ago(now - message.ts)}</span>
          </span>
        );
      })}
    </div>
  );
}

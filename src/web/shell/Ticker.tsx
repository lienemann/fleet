import { useFleet } from "../fleet.tsx";
import { ago } from "../labels.ts";
import { projectsOf } from "../projects.tsx";
import { AgentLabel, useAgentColors } from "../ui/AgentLabel.tsx";
import { useNow } from "../useNow.ts";
import { LIVE_MS } from "../views/Flow.tsx";

/**
 * The message bus: the last two messages between agents, newest first, each with a dot on its
 * wire. A new message's dot crosses three times, then rests at the recipient.
 */
export function Ticker() {
  const { state } = useFleet();
  const tint = useAgentColors();
  const now = useNow(1000);
  const recent = state.messages.slice(-2).reverse();
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
            <AgentLabel agent={message.from} chip={ends !== undefined} />
            <span className="wire" aria-hidden="true">
              <span
                className={now - message.ts < LIVE_MS ? "packet live" : "packet"}
                style={{ background: tint(message.from) }}
              />
            </span>
            <AgentLabel agent={message.to} chip={ends !== undefined} />
            <span className="ticker-body">{first}</span>
            {rest.length > 0 && <span className="dim">+{rest.length} lines</span>}
            <span className="dim">{ago(now - message.ts)}</span>
          </span>
        );
      })}
    </div>
  );
}

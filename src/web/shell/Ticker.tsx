import { useFleet } from "../fleet.tsx";

/** The last two bus messages; a packet runs from sender to receiver when one arrives. */
export function Ticker() {
  const { state, color } = useFleet();
  const recent = state.messages.slice(-2);
  if (recent.length === 0) return null;
  const tint = (agent: string) => color(state.agents[agent]?.color ?? "#888888");
  return (
    <div className="ticker">
      {recent.map((message) => {
        const [first = "", ...rest] = message.body.split("\n");
        return (
          <span key={message.seq} className="ticker-item">
            <span style={{ color: tint(message.from) }}>{message.from}</span>
            <span className="wire">
              {/* Keyed by seq, so the animation restarts for every new message. */}
              <span
                key={message.seq}
                className="packet"
                style={{ background: tint(message.from) }}
              />
            </span>
            <span style={{ color: tint(message.to) }}>{message.to}</span>
            <span className="ticker-body">{first}</span>
            {rest.length > 0 && <span className="dim">+{rest.length} lines</span>}
          </span>
        );
      })}
    </div>
  );
}

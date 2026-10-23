import { useState } from "react";
import { type AgentView, agentList, type Lane, type Segment } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { duration } from "../labels.ts";
import { useNow } from "../useNow.ts";

const WINDOWS = [
  { label: "15 min", ms: 15 * 60_000 },
  { label: "2 h", ms: 2 * 60 * 60_000 },
] as const;

const LANE_LABELS: Record<Lane, string> = {
  queued: "queued",
  running: "working",
  needs_you: "waiting on you",
  review: "in review",
  changes_requested: "revising",
  accepted: "accepted",
  idle: "idle",
  stopped: "stopped",
};

/** Clips an agent's segments to the window, each with its end. */
function visible(history: Segment[], from: number, now: number) {
  return history
    .map((segment, i) => ({ ...segment, to: history[i + 1]?.from ?? now }))
    .filter((s) => s.to > from)
    .map((s) => ({ ...s, from: Math.max(s.from, from) }));
}

/** One lane per agent showing its state over time, with how long it waited on the user. */
export function Timeline({ onOpen }: { onOpen: (agent: string) => void }) {
  const { state, color } = useFleet();
  const now = useNow(10_000);
  const [windowIndex, setWindowIndex] = useState(0);
  const span = WINDOWS[windowIndex] ?? WINDOWS[0];
  const from = now - span.ms;
  const agents = agentList(state).filter(
    (a) => a.history.at(-1)?.lane !== "accepted" || (a.history.at(-1)?.from ?? 0) > from,
  );

  useCommands([
    {
      id: "timeline.window",
      label: "Switch the timeline window (15 min, 2 h)",
      group: "Timeline",
      keys: ["w"],
      priority: 1,
      run: () => setWindowIndex((i) => (i + 1) % WINDOWS.length),
    },
  ]);

  const waiting = (agent: AgentView) =>
    visible(agent.history, from, now)
      .filter((s) => s.lane === "needs_you")
      .reduce((sum, s) => sum + (s.to - s.from), 0);
  const total = agents.reduce((sum, a) => sum + waiting(a), 0);

  return (
    <section className="timeline">
      <header>
        <h2 className="timeline-title">Timeline</h2>
        {WINDOWS.map((w, i) => (
          <button
            key={w.label}
            type="button"
            className={`small ${i === windowIndex ? "active" : ""}`}
            onClick={() => setWindowIndex(i)}
          >
            {w.label}
          </button>
        ))}
        <span className="dim">
          <kbd>w</kbd> switches · agents waited on you {duration(total)} in this window
        </span>
      </header>
      <div className="lanes">
        {agents.map((agent) => (
          <div key={agent.name} className="lane">
            <button
              type="button"
              className="link lane-name"
              style={{ color: color(agent.color) }}
              onClick={() => onOpen(agent.name)}
            >
              {agent.name}
            </button>
            <div className="track">
              {visible(agent.history, from, now).map((s) => (
                <span
                  key={s.from}
                  className={`segment lane-${s.lane}`}
                  style={{
                    left: `${(100 * (s.from - from)) / span.ms}%`,
                    width: `${(100 * (s.to - s.from)) / span.ms}%`,
                  }}
                  title={`${LANE_LABELS[s.lane]} · ${duration(s.to - s.from)}`}
                />
              ))}
            </div>
            <span className="dim lane-wait">
              {waiting(agent) > 0 ? duration(waiting(agent)) : ""}
            </span>
          </div>
        ))}
        {agents.length === 0 && <p className="empty">Nothing happened in this window.</p>}
        <div className="axis">
          <span />
          <div className="axis-range">
            <span>−{span.label}</span>
            <span>now</span>
          </div>
        </div>
      </div>
      <footer className="legend">
        {(["running", "needs_you", "review", "changes_requested", "idle", "stopped"] as const).map(
          (lane) => (
            <span key={lane}>
              <span className={`swatch-box lane-${lane}`} /> {LANE_LABELS[lane]}
            </span>
          ),
        )}
      </footer>
    </section>
  );
}

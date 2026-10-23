import { useState } from "react";
import { type AgentView, agentList, type Lane, type Segment } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { useCommands } from "../keys/keymap.tsx";
import { duration } from "../labels.ts";
import { useNow } from "../useNow.ts";

const WINDOWS = [
  { label: "15 min", ms: 15 * 60_000, tick: 5 * 60_000 },
  { label: "2 h", ms: 2 * 60 * 60_000, tick: 30 * 60_000 },
] as const;

/** "−5 min", "−1 h 30 min": an axis label for a time before now. */
function before(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `−${minutes} min`;
  return minutes % 60 === 0 ? `−${hours} h` : `−${hours} h ${minutes % 60} min`;
}

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
  const at = (ts: number) => `${(100 * (ts - from)) / span.ms}%`;
  const ticks = Array.from({ length: span.ms / span.tick + 1 }, (_, i) => span.ms - i * span.tick);
  const messages = state.messages.filter((m) => m.ts >= from);

  return (
    <section className="timeline">
      <header>
        <fieldset className="segmented" aria-label="Time window">
          {WINDOWS.map((w, i) => (
            <button
              key={w.label}
              type="button"
              aria-pressed={i === windowIndex}
              onClick={() => setWindowIndex(i)}
            >
              {w.label}
            </button>
          ))}
        </fieldset>
        <span className="dim">
          <kbd>w</kbd> switches
        </span>
      </header>
      <div className="lanes">
        <div className="lane axis">
          <span />
          <div className="axis-range">
            {ticks.map((ago) => (
              <span key={ago} style={{ left: at(now - ago) }}>
                {ago === 0 ? "now" : before(ago)}
              </span>
            ))}
          </div>
        </div>
        {agents.map((agent) => (
          <div key={agent.name} className="lane">
            <button type="button" className="link lane-name" onClick={() => onOpen(agent.name)}>
              <span className="name" style={{ color: color(agent.color) }}>
                {agent.name}
              </span>
              <span className="lane-title">{agent.title}</span>
            </button>
            <div className="track">
              {visible(agent.history, from, now).map((s) => (
                <span
                  key={s.from}
                  className={`segment lane-${s.lane}`}
                  style={{ left: at(s.from), width: `${(100 * (s.to - s.from)) / span.ms}%` }}
                  title={`${LANE_LABELS[s.lane]} · ${duration(s.to - s.from)}`}
                />
              ))}
              {messages
                .filter((m) => m.from === agent.name || m.to === agent.name)
                .map((m) => (
                  <span
                    key={m.seq}
                    className="mark"
                    style={{ left: at(m.ts) }}
                    title={`${m.from} to ${m.to}: ${m.body.split("\n")[0]}`}
                  />
                ))}
            </div>
            <span className="lane-wait">
              {waiting(agent) > 0 ? `waited ${duration(waiting(agent))} on you` : ""}
            </span>
          </div>
        ))}
        {agents.length === 0 && <p className="empty">Nothing happened in this window.</p>}
      </div>
      <footer className="legend">
        {(["running", "needs_you", "review", "changes_requested", "idle", "stopped"] as const).map(
          (lane) => (
            <span key={lane}>
              <span className={`swatch-box lane-${lane}`} /> {LANE_LABELS[lane]}
            </span>
          ),
        )}
        <span>
          <span className="swatch-box mark-box" /> message
        </span>
      </footer>
    </section>
  );
}

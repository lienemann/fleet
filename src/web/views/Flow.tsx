import { useMemo, useState } from "react";
import { USER } from "../../shared/events.ts";
import { agentList, type Message } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";
import { useNow } from "../useNow.ts";

const SIZE = 520;
const CENTER = SIZE / 2;
const RADIUS = 200;
/** Messages younger than this are animated as a dot moving from sender to recipient. */
const LIVE_MS = 10_000;

interface Link {
  key: string;
  a: string;
  b: string;
  count: number;
}

const pairKey = (a: string, b: string): string => [a, b].sort().join("\u0000");

/** Agents as nodes, linked by the messages they exchanged; clicking a link filters the list. */
export function Flow({ onOpen }: { onOpen: (agent: string) => void }) {
  const { state, color } = useFleet();
  const now = useNow(1000);
  const [filter, setFilter] = useState<string>();

  const positions = useMemo(() => {
    const agents = agentList(state).filter((a) => a.role === "worker" && a.task !== "accepted");
    const map = new Map<string, { x: number; y: number }>([
      ["director", { x: CENTER, y: CENTER }],
      [USER, { x: CENTER, y: 28 }],
    ]);
    agents.forEach((agent, i) => {
      const angle = Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / Math.max(agents.length, 1);
      map.set(agent.name, {
        x: CENTER + RADIUS * Math.cos(angle),
        y: CENTER + RADIUS * Math.sin(angle) * 0.85,
      });
    });
    return map;
  }, [state]);

  const links = useMemo(() => {
    const byPair = new Map<string, Link>();
    for (const m of state.messages) {
      if (!positions.has(m.from) || !positions.has(m.to)) continue;
      const key = pairKey(m.from, m.to);
      const link = byPair.get(key) ?? { key, a: m.from, b: m.to, count: 0 };
      link.count++;
      byPair.set(key, link);
    }
    return [...byPair.values()];
  }, [state.messages, positions]);

  const live = state.messages.filter((m) => now - m.ts < LIVE_MS);
  const shown: Message[] = (
    filter ? state.messages.filter((m) => pairKey(m.from, m.to) === filter) : state.messages
  )
    .slice(-30)
    .reverse();
  const tint = (agent: string) => color(state.agents[agent]?.color ?? "#a3acbd");
  const at = (agent: string) => positions.get(agent) ?? { x: CENTER, y: CENTER };

  return (
    <div className="flow">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="flow-graph"
        role="img"
        aria-label="Messages between agents"
      >
        {links.map((link) => {
          const a = at(link.a);
          const b = at(link.b);
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG line cannot be a button
            <g
              key={link.key}
              className={`link ${filter === link.key ? "active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => setFilter(filter === link.key ? undefined : link.key)}
              onKeyDown={(e) =>
                e.key === "Enter" && setFilter(filter === link.key ? undefined : link.key)
              }
            >
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeWidth={Math.min(1 + link.count / 2, 6)}
              />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="hit" />
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6}>
                {link.count}
              </text>
            </g>
          );
        })}
        {live.map((m) => {
          const a = at(m.from);
          const b = at(m.to);
          return (
            <circle key={m.seq} r={5} fill={tint(m.from)} className="packet">
              <animateMotion dur="1.4s" repeatCount="3" path={`M${a.x},${a.y} L${b.x},${b.y}`} />
            </circle>
          );
        })}
        {[...positions.entries()].map(([name, p]) => (
          // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a button
          <g
            key={name}
            className="node"
            role="button"
            tabIndex={0}
            transform={`translate(${p.x},${p.y})`}
            onClick={() => state.agents[name] && onOpen(name)}
            onKeyDown={(e) => e.key === "Enter" && state.agents[name] && onOpen(name)}
          >
            <circle r={name === "director" ? 26 : 20} stroke={tint(name)} />
            <text y={4} fill={tint(name)}>
              {name}
            </text>
          </g>
        ))}
      </svg>
      <section className="flow-messages">
        <h2>
          {filter ? "Messages on this link" : "Recent messages"}
          {filter && (
            <button type="button" className="small" onClick={() => setFilter(undefined)}>
              Show all
            </button>
          )}
        </h2>
        {shown.length === 0 && <p className="empty">No messages yet.</p>}
        {shown.map((message) => (
          <MessageItem key={message.seq} message={message} onOpen={onOpen} />
        ))}
      </section>
    </div>
  );
}

import { useMemo, useState } from "react";
import { FLEET_DIRECTOR, USER } from "../../shared/events.ts";
import { agentList, type Message, needsUser } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { agentStatus } from "../labels.ts";
import { useProjectFilter, useProjects, useShownState } from "../projects.tsx";
import { MessageItem } from "../ui/MessageItem.tsx";
import { useNow } from "../useNow.ts";

const SIZE = 640;
const CENTER = SIZE / 2;
const RADIUS = 190;
/** How far a subagent sits beyond its worker, and how far apart siblings fan out. */
const SUB_DISTANCE = 75;
const SUB_SPREAD = 0.45;
/** Angle on each side of the top that no worker takes, in radians. */
const TOP_GAP = 0.7;
/** Messages younger than this are animated as a dot moving from sender to recipient. */
export const LIVE_MS = 10_000;

interface Point {
  x: number;
  y: number;
}

interface Link {
  key: string;
  a: string;
  b: string;
  count: number;
}

/** A running subagent, placed next to the worker that started it. */
interface SubNode extends Point {
  key: string;
  worker: string;
  name: string;
  description: string;
}

const pairKey = (a: string, b: string): string => [a, b].sort().join("\u0000");

/**
 * Agents as nodes, with their state and running subagents. A director sits in the middle, the
 * fleet director when several projects show; links join each director to its workers, and anyone
 * who exchanged messages. Clicking a link filters the list.
 */
export function Flow({ onOpen }: { onOpen: (agent: string) => void }) {
  const { color } = useFleet();
  const state = useShownState();
  const now = useNow(1000);
  const [filter, setFilter] = useState<string>();

  const projects = useProjects();
  const { project } = useProjectFilter();
  const middle =
    project === undefined && projects.length > 1 ? undefined : (project ?? projects[0]?.name);
  // A project without a director reports to the fleet director; with neither shown, the middle
  // stays empty.
  const director =
    (middle === undefined ? undefined : projects.find((p) => p.name === middle)?.director) ??
    FLEET_DIRECTOR;
  const hub = director in state.agents ? director : undefined;

  const { positions, subs, parents } = useMemo(() => {
    const directors = new Map(projects.map((p) => [p.name, p.director]));
    /** Who sits at the other end of an agent's link before any message: its own director. */
    const parents = new Map<string, string>();
    // Around the hub: the workers, and the other directors.
    const ring = agentList(state).filter(
      (a) =>
        (a.role === "worker" && a.task !== "accepted") || (a.role === "director" && a.name !== hub),
    );
    const positions = new Map<string, Point>([[USER, { x: CENTER, y: 36 }]]);
    if (hub) positions.set(hub, { x: CENTER, y: CENTER });
    const subs: SubNode[] = [];
    // The ellipse is flatter than the circle, so that the user fits above it.
    const place = (angle: number, radius: number): Point => ({
      x: CENTER + radius * Math.cos(angle),
      y: CENTER + radius * Math.sin(angle) * 0.85,
    });
    ring.forEach((worker, i) => {
      // Workers spread around the director, leaving the top to the user.
      const angle =
        -Math.PI / 2 + TOP_GAP + ((2 * Math.PI - 2 * TOP_GAP) * (i + 0.5)) / ring.length;
      positions.set(worker.name, place(angle, RADIUS));
      const own = directors.get(worker.project ?? "");
      const parent = own && own !== worker.name && own in state.agents ? own : hub;
      if (parent) parents.set(worker.name, parent);
      const running = worker.subagents.flatMap((s, n) => (s.done ? [] : [{ ...s, n: n + 1 }]));
      // Off the line through the director, where the worker's labels are.
      const shift = running.length % 2 === 1 ? SUB_SPREAD / 2 : 0;
      running.forEach((sub, j) => {
        const offset = (j - (running.length - 1) / 2) * SUB_SPREAD + shift;
        subs.push({
          ...place(angle + offset, RADIUS + SUB_DISTANCE),
          key: sub.toolUseId,
          worker: worker.name,
          name: `sub#${sub.n}`,
          description: sub.description,
        });
      });
    });
    return { positions, subs, parents };
  }, [state, hub, projects]);

  const links = useMemo(() => {
    const byPair = new Map<string, Link>();
    const add = (a: string, b: string, count: number) => {
      const key = pairKey(a, b);
      const link = byPair.get(key) ?? { key, a, b, count: 0 };
      link.count += count;
      byPair.set(key, link);
    };
    for (const [name, parent] of parents) add(parent, name, 0);
    for (const m of state.messages) {
      if (positions.has(m.from) && positions.has(m.to)) add(m.from, m.to, 1);
    }
    return [...byPair.values()];
  }, [state.messages, positions, parents]);

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
              className={`link ${filter === link.key ? "active" : ""} ${link.count === 0 ? "quiet" : ""}`}
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
              {link.count > 0 && (
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6}>
                  {link.count}
                </text>
              )}
            </g>
          );
        })}
        {subs.map((sub) => {
          const w = at(sub.worker);
          const out = `M${w.x},${w.y} L${sub.x},${sub.y}`;
          return (
            <g key={sub.key} className="sub-link">
              <line x1={w.x} y1={w.y} x2={sub.x} y2={sub.y} />
              {/* Tool traffic, not messages: a dot that keeps going back and forth. */}
              <circle r={3.5} fill={tint(sub.worker)} className="packet">
                <animateMotion
                  dur="2.4s"
                  repeatCount="indefinite"
                  path={out}
                  keyPoints="0;1;0"
                  keyTimes="0;0.5;1"
                  calcMode="linear"
                />
              </circle>
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
        {[...positions.entries()].map(([name, p]) => {
          const agent = state.agents[name];
          const r = name === hub ? 26 : 20;
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a button
            <g
              key={name}
              className={`node ${agent?.task === "queued" ? "faded" : ""}`}
              role="button"
              tabIndex={0}
              transform={`translate(${p.x},${p.y})`}
              onClick={() => agent && onOpen(name)}
              onKeyDown={(e) => e.key === "Enter" && agent && onOpen(name)}
            >
              {agent && needsUser(agent) && <circle r={r + 7} className="needs-ring" />}
              <circle r={r} stroke={tint(name)} />
              <text y={r + 15} className="name" fill={tint(name)}>
                {name}
              </text>
              <text y={r + 28} className="state">
                {agent ? agentStatus(agent).label : ""}
              </text>
            </g>
          );
        })}
        {subs.map((sub) => (
          // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a button
          <g
            key={sub.key}
            className="node sub"
            role="button"
            tabIndex={0}
            transform={`translate(${sub.x},${sub.y})`}
            onClick={() => onOpen(sub.worker)}
            onKeyDown={(e) => e.key === "Enter" && onOpen(sub.worker)}
          >
            <title>{sub.description}</title>
            <circle r={12} stroke={tint(sub.worker)} />
            <text y={26} className="name" fill={tint(sub.worker)}>
              {sub.name}
            </text>
            <text y={38} className="state">
              subagent
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
        {shown.length === 0 && (
          <p className="empty">{filter ? "No messages on this link yet." : "No messages yet."}</p>
        )}
        {shown.map((message) => (
          <MessageItem key={message.seq} message={message} onOpen={onOpen} />
        ))}
      </section>
    </div>
  );
}

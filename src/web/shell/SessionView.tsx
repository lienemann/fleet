import { useState } from "react";
import type { ContextCategory } from "../../shared/events.ts";
import type { AgentView } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { MODE_LABELS } from "../labels.ts";
import { canHandOver } from "../tile/CliBar.tsx";

/** Outputs shown before "Show more". */
const OUTPUTS_SHOWN = 5;

const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

/**
 * Where the session runs, what fills its context window, and which files it wrote: the side
 * panel of the Claude desktop app, for one agent.
 */
export function SessionView({ agent }: { agent: AgentView }) {
  return (
    <div className="drawer-scroll session-view">
      <Environment agent={agent} />
      <Context agent={agent} />
      <Outputs agent={agent} />
    </div>
  );
}

function Environment({ agent }: { agent: AgentView }) {
  return (
    <section className="panel">
      <h3>Environment</h3>
      <dl>
        <dt>Host</dt>
        <dd>{agent.host}</dd>
        <dt>Workspace</dt>
        <dd title={agent.cwd}>
          {agent.workspace} · <code>{agent.cwd}</code>
        </dd>
        <dt>Model</dt>
        <dd>{agent.model ?? "default"}</dd>
        <dt>Permissions</dt>
        <dd>{MODE_LABELS[agent.permissionMode]}</dd>
        <dt>Session</dt>
        <dd>
          <code>{agent.sessionId ?? "not started"}</code>
          {agent.activity === "detached" && " · in a terminal"}
        </dd>
      </dl>
    </section>
  );
}

function Context({ agent }: { agent: AgentView }) {
  const { send } = useFleet();
  const context = agent.context;
  if (!context) {
    return (
      <section className="panel">
        <h3>Context</h3>
        <p className="empty">Known after the first turn.</p>
      </section>
    );
  }
  const share = (n: number) => (100 * n) / context.window;
  const inWindow = context.categories.filter((c) => c.kind !== "deferred");
  const deferred = context.categories.filter((c) => c.kind === "deferred");
  const untilCompact =
    context.autoCompactAt !== undefined ? context.autoCompactAt - context.tokens : undefined;
  const live = agent.activity === "working" || agent.activity === "idle";

  return (
    <section className="panel">
      <h3>Context</h3>
      <div className="context-total">
        <strong>{Math.round(share(context.tokens))}% used</strong>
        <span className="dim">
          {tokens(context.tokens)} / {tokens(context.window)}
        </span>
      </div>
      <div className="context-bar">
        {inWindow
          .filter((c) => c.kind !== "free")
          .map((c) => (
            <span
              key={c.id ?? c.name}
              className={categoryClass(c)}
              style={{ width: `${share(c.tokens)}%` }}
            />
          ))}
      </div>
      <table className="context-table">
        <tbody>
          {inWindow.map((c) => (
            <tr key={c.id ?? c.name}>
              <td>
                <span className={`swatch-box ${categoryClass(c)}`} /> {c.name}
              </td>
              <td className="dim">{tokens(c.tokens)}</td>
              <td>{share(c.tokens).toFixed(1)}%</td>
            </tr>
          ))}
          {deferred.map((c) => (
            <tr key={c.id ?? c.name} className="dim">
              <td>
                <span className={`swatch-box ${categoryClass(c)}`} /> {c.name}
              </td>
              <td>{tokens(c.tokens)}</td>
              <td>–</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="context-foot">
        <span className="dim">
          {untilCompact !== undefined
            ? `${tokens(Math.max(0, untilCompact))} until auto-compact`
            : "Auto-compact is off"}
        </span>
        <button
          type="button"
          className="small"
          disabled={!live}
          onClick={() => send({ type: "prompt", agent: agent.name, text: "/compact" })}
        >
          Compact session
        </button>
        <button
          type="button"
          className="small"
          disabled={!canHandOver(agent)}
          title="This session writes a handover; a fresh one reads it and carries on"
          onClick={() => send({ type: "handover", agent: agent.name })}
        >
          Hand over
        </button>
      </footer>
    </section>
  );
}

/** Color classes follow the CLI's /context: messages blue, tools orange, skills green, the rest grey. */
function categoryClass(category: ContextCategory): string {
  if (category.kind === "free") return "cat-free";
  if (category.kind === "buffer") return "cat-buffer";
  return `cat-${category.id ?? "other"}`;
}

function Outputs({ agent }: { agent: AgentView }) {
  const [all, setAll] = useState(false);
  const relative = (path: string) =>
    path.startsWith(`${agent.cwd}/`) ? path.slice(agent.cwd.length + 1) : path;
  const shown = all ? agent.outputs : agent.outputs.slice(0, OUTPUTS_SHOWN);
  return (
    <section className="panel">
      <h3>Outputs</h3>
      {agent.outputs.length === 0 && <p className="empty">No files written yet.</p>}
      <ul className="outputs">
        {shown.map((path) => (
          <li key={path} title={path}>
            <code>{relative(path)}</code>
          </li>
        ))}
      </ul>
      {agent.outputs.length > OUTPUTS_SHOWN && (
        <button type="button" className="link dim" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show ${agent.outputs.length - OUTPUTS_SHOWN} more`}
        </button>
      )}
    </section>
  );
}

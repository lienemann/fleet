import { EFFORT_LEVELS, type ModelChoice, PERMISSION_MODES } from "../../shared/events.ts";
import type { AgentView } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { contextPercent, effortsOf, MODE_LABELS, modelLabel } from "../labels.ts";

/** Until the daemon has asked Claude Code for its models. */
const FALLBACK_MODELS: ModelChoice[] = ["opus", "sonnet", "haiku"].map((value) => ({
  value,
  label: value,
  efforts: [],
}));

/** The CLI's status line: permission mode, model, effort, context, and session controls. */
export function CliBar({ agent }: { agent: AgentView }) {
  const { send, state } = useFleet();
  const name = agent.name;
  const live = agent.activity === "working" || agent.activity === "idle";
  const nextMode =
    PERMISSION_MODES[
      (PERMISSION_MODES.indexOf(agent.permissionMode) + 1) % PERMISSION_MODES.length
    ];
  const percent = contextPercent(agent);
  const known = state.models.length > 0 ? state.models : FALLBACK_MODELS;
  // A running session reports the full id; it takes its alias's place in the list.
  const listed = known
    .filter((m) => m.value !== "default")
    .map((m) => (agent.model !== undefined && m.resolved === agent.model ? agent.model : m.value));
  const values = [
    ...new Set(agent.model && !listed.includes(agent.model) ? [agent.model, ...listed] : listed),
  ];

  return (
    <div className="cli-bar">
      <div className="cli-state">
        <button
          type="button"
          className={`cli-pill mode-${agent.permissionMode}`}
          title="Permission mode (click to cycle)"
          onClick={() => nextMode && send({ type: "set_mode", agent: name, mode: nextMode })}
        >
          mode: {MODE_LABELS[agent.permissionMode]}
        </button>
        <select
          className="cli-pill"
          title="Model"
          value={agent.model ?? ""}
          onChange={(event) => send({ type: "set_model", agent: name, model: event.target.value })}
        >
          {!agent.model && <option value="">{modelLabel(state.models)}</option>}
          {values.map((value) => (
            <option key={value} value={value}>
              {modelLabel(known, value)}
            </option>
          ))}
        </select>
        <select
          className="cli-pill"
          title="Effort"
          value={agent.effort ?? ""}
          onChange={(event) =>
            send({
              type: "set_effort",
              agent: name,
              effort: EFFORT_LEVELS.find((level) => level === event.target.value) ?? null,
            })
          }
        >
          <option value="">effort: default</option>
          {effortsOf(state.models, agent.model).map((level) => (
            <option key={level} value={level}>
              effort: {level}
            </option>
          ))}
        </select>
        {percent !== undefined && (
          <span
            className="context"
            title={`${agent.context?.tokens} of ${agent.context?.window} tokens`}
          >
            ctx
            <span className="meter">
              <span style={{ width: `${percent}%` }} className={percent >= 70 ? "high" : ""} />
            </span>
            {percent}%
          </span>
        )}
      </div>
      <div className="cli-actions">
        <button
          type="button"
          className="outline"
          disabled={!live}
          onClick={() => send({ type: "prompt", agent: name, text: "/compact" })}
        >
          /compact
        </button>
        <button
          type="button"
          className="outline"
          disabled={!canHandOver(agent)}
          title="Continue in a fresh session: this one writes a handover, a new one reads it (Shift+H)"
          onClick={() => send({ type: "handover", agent: name })}
        >
          Hand over
        </button>
        <button
          type="button"
          className="outline"
          disabled={agent.activity !== "working"}
          onClick={() => send({ type: "interrupt", agent: name })}
          title="Interrupt (Esc)"
        >
          Interrupt
        </button>
        {live ? (
          <button
            type="button"
            className="outline"
            onClick={() => send({ type: "stop", agent: name })}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="outline"
            disabled={agent.task === "queued"}
            onClick={() => send({ type: "start", agent: name })}
          >
            {agent.activity === "detached" ? "Take back" : "Start"}
          </button>
        )}
        {live && agent.sessionId && (
          <button
            type="button"
            className="outline"
            title="Release the session to continue it in a terminal"
            onClick={() => send({ type: "detach", agent: name })}
          >
            Terminal
          </button>
        )}
      </div>
    </div>
  );
}

/** A handover needs a session that has run, is not mid-turn and is not held by a terminal. */
export const canHandOver = (agent: AgentView): boolean =>
  agent.sessionId !== undefined &&
  agent.activity !== "working" &&
  agent.activity !== "detached" &&
  agent.handover?.state !== "writing";

import { PERMISSION_MODES } from "../../shared/events.ts";
import type { AgentView } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { MODE_LABELS } from "../labels.ts";

const MODELS = ["opus", "sonnet", "haiku"];

/** The CLI's status line: permission mode, model, context, and session controls. */
export function CliBar({ agent }: { agent: AgentView }) {
  const { send } = useFleet();
  const name = agent.name;
  const live = agent.activity === "working" || agent.activity === "idle";
  const nextMode =
    PERMISSION_MODES[
      (PERMISSION_MODES.indexOf(agent.permissionMode) + 1) % PERMISSION_MODES.length
    ];
  const percent = agent.context
    ? Math.round((100 * agent.context.tokens) / agent.context.window)
    : undefined;
  const models = agent.model && !MODELS.includes(agent.model) ? [agent.model, ...MODELS] : MODELS;

  return (
    <div className="cli-bar">
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
        {!agent.model && <option value="">default model</option>}
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
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
      <span className="spacer" />
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
  );
}

/** A handover needs a session that has run, is not mid-turn and is not held by a terminal. */
export const canHandOver = (agent: AgentView): boolean =>
  agent.sessionId !== undefined &&
  agent.activity !== "working" &&
  agent.activity !== "detached" &&
  agent.handover?.state !== "writing";

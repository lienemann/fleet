import { EFFORT_LEVELS, type ModelChoice, PERMISSION_MODES } from "../../shared/events.ts";
import type { AgentView } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { contextPercent, effortsOf, MODE_LABELS, modelId, modelLabel } from "../labels.ts";
import { Menu } from "../ui/Menu.tsx";
import { attachAgent, endsHolder } from "./attach.ts";

/** Until the daemon has asked Claude Code for its models. */
const FALLBACK_MODELS: ModelChoice[] = ["opus", "sonnet", "haiku"].map((value) => ({
  value,
  label: value,
  efforts: [],
}));

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The status line under the prompt, quiet like the Claude desktop app's: permission mode and
 * context on the left, model, effort and session controls on the right.
 */
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
          {capitalized(MODE_LABELS[agent.permissionMode])}
        </button>
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
        <select
          className="cli-pill"
          aria-label="Model"
          title={`Model: ${modelId(state.models, agent.model)}`}
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
          <option value="">Default effort</option>
          {effortsOf(state.models, agent.model).map((level) => (
            <option key={level} value={level}>
              {capitalized(level)}
            </option>
          ))}
        </select>
        {live ? (
          <button
            type="button"
            className="outline"
            onClick={() => send({ type: "stop", agent: name })}
          >
            Stop
          </button>
        ) : agent.activity === "detached" ? (
          <button
            type="button"
            className="outline"
            disabled={Boolean(agent.holder) && !endsHolder(agent.holder)}
            title="End the client that holds the session and run it in fleet"
            onClick={() => attachAgent(agent, send)}
          >
            Attach
          </button>
        ) : (
          <button
            type="button"
            className="outline"
            disabled={agent.task === "queued"}
            onClick={() => send({ type: "start", agent: name })}
          >
            Start
          </button>
        )}
        <Menu
          label="Session actions"
          items={[
            {
              label: "Interrupt",
              title: "Esc",
              disabled: agent.activity !== "working",
              run: () => send({ type: "interrupt", agent: name }),
            },
            {
              label: "/compact",
              title: "Summarise the conversation to free the context window",
              disabled: !live,
              run: () => send({ type: "prompt", agent: name, text: "/compact" }),
            },
            {
              label: "Hand over",
              title:
                "Continue in a fresh session: this one writes a handover, a new one reads it (Shift+H)",
              disabled: !canHandOver(agent),
              run: () => send({ type: "handover", agent: name }),
            },
            {
              label: "Continue in a terminal",
              title: "Release the session to continue it in a terminal",
              disabled: !live || !agent.sessionId,
              run: () => send({ type: "detach", agent: name }),
            },
          ]}
        />
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

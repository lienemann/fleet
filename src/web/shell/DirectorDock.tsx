import { type FormEvent, useState } from "react";
import { FLEET_DIRECTOR } from "../../shared/events.ts";
import { useFleet } from "../fleet.tsx";
import { type Command, useCommands } from "../keys/keymap.tsx";
import { useProjects } from "../projects.tsx";

/**
 * A director's latest reply and a prompt to it, always at hand: the fleet director's, or, picked
 * in the dock, a project's director.
 */
export function DirectorDock({ onOpen }: { onOpen: (agent: string) => void }) {
  const { state, send, color } = useFleet();
  const projects = useProjects();
  const [draft, setDraft] = useState("");
  const [chosen, setChosen] = useState<string>();
  const directors = [
    { name: FLEET_DIRECTOR, label: "Fleet director", whom: "the fleet director" },
    ...projects.flatMap((p) =>
      p.director
        ? [{ name: p.director, label: `Director of ${p.name}`, whom: `the director of ${p.name}` }]
        : [],
    ),
  ].filter((d) => state.agents[d.name]);
  const target = directors.find((d) => d.name === chosen) ?? directors[0];
  const director = target && state.agents[target.name];

  useCommands(
    directors.length > 1
      ? directors.map(
          (d): Command => ({
            id: `dock.${d.name}`,
            label: `Talk to ${d.whom} in the dock`,
            group: "Fleet",
            run: () => setChosen(d.name),
          }),
        )
      : [],
  );

  if (!target || !director) return null;
  const reply = director.log.findLast((line) => line.role === "assistant" && line.parent === null);

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!draft.trim()) return;
    send({ type: "prompt", agent: target.name, text: draft.trim() });
    setDraft("");
  };

  return (
    <form className="dock" onSubmit={submit}>
      {directors.length > 1 && (
        <select
          className="dock-pick"
          aria-label="Talk to"
          value={target.name}
          onChange={(e) => setChosen(e.target.value)}
        >
          {directors.map((d) => (
            <option key={d.name} value={d.name}>
              {d.label}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="link name"
        style={{ color: color(director.color) }}
        title={`Open ${target.name}`}
        onClick={() => onOpen(target.name)}
      >
        {target.name}
      </button>
      {(director.activity === "working" || reply) && (
        <span className="dock-reply" title={reply?.text}>
          {director.activity === "working" ? "thinking…" : reply?.text.split("\n")[0]}
        </span>
      )}
      <textarea
        data-dock
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={`Message ${target.whom}… (Shift+Enter for a new line)`}
      />
      <button type="submit" className="primary" disabled={!draft.trim()}>
        Send
      </button>
    </form>
  );
}

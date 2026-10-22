import { type FormEvent, useState } from "react";
import { DIRECTOR } from "../../shared/events.ts";
import { useFleet } from "../fleet.tsx";

/** The director's latest reply and a prompt to it, always at hand. */
export function DirectorDock({ onOpen }: { onOpen: (agent: string) => void }) {
  const { state, send, color } = useFleet();
  const [draft, setDraft] = useState("");
  const director = state.agents[DIRECTOR];
  if (!director) return null;
  const reply = director.log.findLast((line) => line.role === "assistant" && line.parent === null);

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!draft.trim()) return;
    send({ type: "prompt", agent: DIRECTOR, text: draft.trim() });
    setDraft("");
  };

  return (
    <form className="dock" onSubmit={submit}>
      <button
        type="button"
        className="link dock-name"
        style={{ color: color(director.color) }}
        onClick={() => onOpen(DIRECTOR)}
      >
        director
      </button>
      <span className="dock-reply" title={reply?.text}>
        {director.activity === "working"
          ? "thinking…"
          : (reply?.text.split("\n")[0] ?? "Tell the director what to get done.")}
      </span>
      <textarea
        data-dock
        value={draft}
        rows={Math.min(6, draft.split("\n").length)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Message the director… (Shift+Enter for a new line)"
      />
      <button type="submit" className="primary" disabled={!draft.trim()}>
        Send
      </button>
    </form>
  );
}

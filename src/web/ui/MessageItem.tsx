import type { Message } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { projectsOf } from "../projects.tsx";
import { Markdown } from "./Markdown.tsx";

/** One message between agents: sender, recipient and the Markdown body as written. */
export function MessageItem({
  message,
  onOpen,
}: {
  message: Message;
  onOpen?: (agent: string) => void;
}) {
  const { state, color } = useFleet();
  const name = (agent: string) => (
    <button
      type="button"
      className="link name"
      style={{ color: color(state.agents[agent]?.color ?? "#888888") }}
      disabled={!state.agents[agent] || !onOpen}
      onClick={() => onOpen?.(agent)}
    >
      {agent}
    </button>
  );
  const ends = projectsOf(state, message);
  const chip = (project: string | undefined) =>
    project && <span className="project-chip">{project}</span>;
  return (
    <article className="message">
      <header>
        {name(message.from)}
        {chip(ends?.[0])} → {name(message.to)}
        {chip(ends?.[1])}
        <time className="dim">{new Date(message.ts).toLocaleTimeString()}</time>
      </header>
      <Markdown text={message.body} />
    </article>
  );
}

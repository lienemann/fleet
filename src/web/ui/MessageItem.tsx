import type { Message } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { projectsOf } from "../projects.tsx";
import { AgentLabel } from "./AgentLabel.tsx";
import { Markdown } from "./Markdown.tsx";

/** One message between agents: sender, recipient and the Markdown body as written. */
export function MessageItem({
  message,
  onOpen,
}: {
  message: Message;
  onOpen?: (agent: string) => void;
}) {
  const { state } = useFleet();
  // The chips only show where the message crosses from one project to another.
  const chip = projectsOf(state, message) !== undefined;
  return (
    <article className="message">
      <header>
        <AgentLabel agent={message.from} chip={chip} onOpen={onOpen} /> →{" "}
        <AgentLabel agent={message.to} chip={chip} onOpen={onOpen} />
        <time className="dim">{new Date(message.ts).toLocaleTimeString()}</time>
      </header>
      <Markdown text={message.body} />
    </article>
  );
}

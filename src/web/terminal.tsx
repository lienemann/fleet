import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { LOCAL, locate } from "../shared/hosts.ts";
import type { AgentView } from "../shared/reducer.ts";
import { copyText } from "./clipboard.ts";
import { useFleet } from "./fleet.tsx";

/** What failed to open, and the line that does it by hand. */
interface Unopened {
  reason: string;
  command: string;
}

interface Terminals {
  /**
   * Opens a terminal in a directory of an agent or a workspace; `owner` is its name, which says
   * whether the directory is on a remote's host.
   */
  open: (owner: string, dir: string, session?: string) => void;
  /** Releases the agent's session and continues it in a terminal once fleet has let go of it. */
  handOver: (agent: AgentView) => void;
  unopened: Unopened | undefined;
  dismiss: () => void;
}

const TerminalContext = createContext<Terminals | undefined>(undefined);

/** Quotes a path for a POSIX shell. */
const quoted = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;

export function useTerminals(): Terminals {
  const terminals = useContext(TerminalContext);
  if (!terminals) throw new Error("useTerminals outside TerminalProvider");
  return terminals;
}

/** The terminals the daemon opens on this computer, and what to do by hand when one does not open. */
export function TerminalProvider({ children }: { children: ReactNode }) {
  const { state, info, send, call } = useFleet();
  const [unopened, setUnopened] = useState<Unopened>();
  // Agents whose session goes to a terminal as soon as fleet has released it.
  const [handing, setHanding] = useState<ReadonlySet<string>>(new Set());
  const remotes = info?.remotes;

  const open = useCallback(
    (owner: string, dir: string, session?: string): void => {
      const { host } = locate(owner, remotes ?? []);
      call({
        type: "open_terminal",
        dir,
        ...(host !== LOCAL && { remote: host }),
        ...(session !== undefined && { session }),
      }).then(
        (reply) => setUnopened(reply.opened ? undefined : reply),
        (error: Error) =>
          setUnopened({ reason: error.message.replace(/\.$/, ""), command: `cd ${quoted(dir)}` }),
      );
    },
    [call, remotes],
  );

  const handOver = useCallback(
    (agent: AgentView): void => {
      send({ type: "detach", agent: agent.name });
      setHanding((was) => new Set(was).add(agent.name));
    },
    [send],
  );

  useEffect(() => {
    if (handing.size === 0) return;
    const left = new Set(handing);
    for (const name of handing) {
      const agent = state.agents[name];
      if (agent?.activity === "detached") {
        if (agent.sessionId) open(name, agent.cwd, agent.sessionId);
      } else if (agent && agent.activity !== "stopped") {
        continue;
      }
      // Released, stopped or gone: nothing waits any more.
      left.delete(name);
    }
    if (left.size !== handing.size) setHanding(left);
  }, [state, handing, open]);

  const dismiss = useCallback(() => setUnopened(undefined), []);
  return (
    <TerminalContext.Provider value={{ open, handOver, unopened, dismiss }}>
      {children}
    </TerminalContext.Provider>
  );
}

/** Why a terminal did not open, with the line to copy instead. */
export function UnopenedTerminal() {
  const { unopened, dismiss } = useTerminals();
  // The line last copied, so a new one shows its button fresh.
  const [copied, setCopied] = useState<string>();
  if (!unopened) return null;
  const { reason, command } = unopened;
  return (
    <div className="banner terminal-banner" role="alert">
      <span>{reason}.</span>
      <code>{command}</code>
      <button
        type="button"
        className="outline"
        onClick={() => void copyText(command).then((ok) => ok && setCopied(command))}
      >
        {copied === command ? "Copied" : "Copy command"}
      </button>
      <button type="button" className="close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}

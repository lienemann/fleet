import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { USER } from "../shared/events.ts";
import { type AgentView, agentList, type FleetState } from "../shared/reducer.ts";
import { isFree, removable, workspaceHolder } from "../shared/tasks.ts";
import { useFleet } from "./fleet.tsx";
import { Dialog, DialogButtons } from "./ui/Dialog.tsx";
import { useSubmit } from "./useSubmit.ts";

/** Moves of an agent that ask first, wherever they are offered: the rail, a tile, the palette. */
interface AgentMoves {
  /** Asks which workspace a guest becomes the worker of. */
  makeWorker: (agent: string) => void;
  /** Asks before a guest or a free investigator leaves fleet. */
  remove: (agent: string) => void;
}

const AgentMovesContext = createContext<AgentMoves | undefined>(undefined);

/** Holds the dialogs of the agent moves, so any component can open them. */
export function AgentMovesProvider({ children }: { children: ReactNode }) {
  // A new id for each opening, so asking again starts the dialog afresh.
  const [asking, setAsking] = useState<{ move: keyof AgentMoves; agent: string; id: number }>();
  const moves = useMemo<AgentMoves>(
    () => ({
      makeWorker: (agent) => setAsking({ move: "makeWorker", agent, id: Math.random() }),
      remove: (agent) => setAsking({ move: "remove", agent, id: Math.random() }),
    }),
    [],
  );
  const close = (): void => setAsking(undefined);
  return (
    <AgentMovesContext value={moves}>
      {children}
      {asking?.move === "makeWorker" && (
        <MakeWorker key={asking.id} name={asking.agent} onClose={close} />
      )}
      {asking?.move === "remove" && (
        <RemoveAgent key={asking.id} name={asking.agent} onClose={close} />
      )}
    </AgentMovesContext>
  );
}

export function useAgentMoves(): AgentMoves {
  const moves = useContext(AgentMovesContext);
  if (!moves) throw new Error("useAgentMoves outside AgentMovesProvider");
  return moves;
}

/**
 * The moves an agent offers, the same in every menu and in the palette: Make worker for a
 * guest, Remove for one that may leave.
 */
export function agentMoveItems(
  agent: AgentView,
  moves: AgentMoves,
): Array<{ id: string; label: string; title: string; run: () => void }> {
  return [
    ...(agent.guest
      ? [
          {
            id: "make_worker",
            label: "Make worker of …",
            title: `Move ${agent.name}'s conversation into a workspace of its own and make it the worker there`,
            run: () => moves.makeWorker(agent.name),
          },
        ]
      : []),
    ...(removable(agent)
      ? [
          {
            id: "remove",
            label: "Remove from fleet",
            title: `Take ${agent.name} out of fleet; its session stays with Claude Code`,
            run: () => moves.remove(agent.name),
          },
        ]
      : []),
  ];
}

/** What the inbox holds for an agent, one line per item, for the question before it leaves. */
function unreadItems(state: FleetState, agent: AgentView): string[] {
  const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
  return [
    ...(agent.pending > 0
      ? [`${agent.pending} request${agent.pending === 1 ? "" : "s"} for you`]
      : []),
    ...agent.finished.filter((run) => !run.read).map((run) => `Finished: ${firstLine(run.text)}`),
    ...state.messages
      .filter((m) => m.from === agent.name && m.to === USER && !m.read)
      .map((m) => `Message: ${firstLine(m.body)}`),
    ...Object.values(state.openPoints)
      .filter((doc) => doc.agent === agent.name)
      .map((doc) => `Open points: ${doc.path}`),
  ];
}

/** The inbox items that leave with an agent, if it has any. */
export function LeavingItems({ agent }: { agent: AgentView }) {
  const { state } = useFleet();
  const items = unreadItems(state, agent);
  if (items.length === 0) return null;
  return (
    <>
      <p>These items of {agent.name}'s leave the inbox with it:</p>
      <ul className="leaving-items">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

/** Stands for the workspace fleet opens for the guest. */
const NEW = "";

/**
 * Asks which workspace of its project a guest becomes the worker of: one whose worker is free,
 * which then leaves fleet, or a new one fleet opens. A fork of the guest's conversation goes on
 * there.
 */
function MakeWorker({ name, onClose }: { name: string; onClose: () => void }) {
  const { state, info, call, send } = useFleet();
  const agent = state.agents[name];
  const project = agent?.project;
  const [offer, setOffer] = useState<string>();
  useEffect(() => {
    if (project === undefined) return;
    call({ type: "new_workspace", project }).then(
      (next) => setOffer(next.name),
      () => setOffer(undefined),
    );
  }, [call, project]);
  const agents = agentList(state);
  const targets = (info?.workspaces ?? [])
    .filter((ws) => ws.project === project)
    .map((ws) => {
      const worker = agents.find((a) => a.role === "worker" && !a.guest && a.workspace === ws.name);
      const holder = workspaceHolder(state, ws.name);
      const busy =
        worker && !isFree(state, worker)
          ? `${worker.name} ${worker.task === undefined ? "is busy" : `holds ${worker.task}`}`
          : holder && `held by ${holder}`;
      return { name: ws.name, worker, busy };
    });
  const [chosen, setChosen] = useState<string>();
  const choice = chosen ?? targets.find((t) => !t.busy)?.name ?? NEW;
  const leaving = targets.find((t) => t.name === choice)?.worker;
  const { submit, pending, error } = useSubmit(
    () => call({ type: "make_worker", agent: name, workspace: choice || undefined }),
    onClose,
  );
  if (!agent) return null;
  const working = agent.activity === "working";

  return (
    <Dialog
      title={
        <>
          Make <span className="name">{name}</span> a worker
        </>
      }
      label={`Make ${name} a worker`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <p>
          {name}'s conversation goes on in the workspace you pick, and {name} becomes its worker: it
          takes tasks from then on. What it changed in <code>{agent.cwd}</code> stays there.
        </p>
        <fieldset className="pick-list">
          <legend>Workspace</legend>
          {targets.map((t) => (
            <label key={t.name} className={`option ${t.busy ? "dim" : ""}`}>
              <input
                type="radio"
                name="workspace"
                disabled={Boolean(t.busy)}
                checked={choice === t.name}
                onChange={() => setChosen(t.name)}
              />
              <span>{t.name}</span>
              <small>
                {t.busy ?? (t.worker ? `${t.worker.name} is free and leaves fleet` : "free")}
              </small>
            </label>
          ))}
          <label className="option">
            <input
              type="radio"
              name="workspace"
              checked={choice === NEW}
              onChange={() => setChosen(NEW)}
            />
            <span>A new workspace{offer && ` ${offer}`}</span>
            <small>fleet opens it next to the repo</small>
          </label>
        </fieldset>
        {leaving && <LeavingItems agent={leaving} />}
        {working && (
          <p className="banner">
            {name} is in the middle of a turn.{" "}
            <button
              type="button"
              className="link"
              onClick={() => send({ type: "interrupt", agent: name })}
            >
              Interrupt
            </button>
          </p>
        )}
        {agent.activity === "detached" && agent.holder && (
          <p className="dim">
            fleet first ends the client that has the session open, as Attach does.
          </p>
        )}
        {error && <p className="banner">{error}</p>}
        <DialogButtons submit="Make worker" disabled={pending || working} />
      </form>
    </Dialog>
  );
}

/** Asks before a guest or a free investigator leaves fleet, naming what leaves the inbox with it. */
function RemoveAgent({ name, onClose }: { name: string; onClose: () => void }) {
  const { state, call } = useFleet();
  const agent = state.agents[name];
  const { submit, pending, error } = useSubmit(
    () => call({ type: "remove_agent", agent: name }),
    onClose,
  );
  if (!agent) return null;
  return (
    <Dialog
      title={
        <>
          Remove <span className="name">{name}</span>?
        </>
      }
      label={`Remove ${name}`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <p>
          {name} leaves fleet
          {agent.activity === "working" && ", and its current turn ends"}. Its session stays with
          Claude Code, to resume in a terminal or import again.
        </p>
        <LeavingItems agent={agent} />
        {error && <p className="banner">{error}</p>}
        <DialogButtons submit="Remove" disabled={pending} />
      </form>
    </Dialog>
  );
}

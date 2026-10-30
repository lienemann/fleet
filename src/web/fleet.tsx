import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { themedColor } from "../shared/colors.ts";
import type { FleetEvent } from "../shared/events.ts";
import { LOCAL, mergeInfo, mergeStates, routeCall, routeCommand } from "../shared/hosts.ts";
import type { Call, CallResults, Command, DaemonInfo } from "../shared/protocol.ts";
import { emptyState, type FleetState, reduceAll } from "../shared/reducer.ts";
import { Connection } from "./connection.ts";
import { type Theme, useTheme } from "./useTheme.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A call as the caller writes it; the id is added on sending. */
type CallRequest = DistributiveOmit<Call, "id">;

export interface Fleet {
  /** All daemons merged; remote agents are named `<host>/<agent>`. */
  state: FleetState;
  info: DaemonInfo | undefined;
  /** Connected to the local daemon. */
  connected: boolean;
  /** Remote daemons currently out of reach. */
  offline: string[];
  send: (message: Command) => void;
  /** Sends a request to the daemon owning the agent and resolves with its reply. */
  call: <R extends CallRequest>(request: R) => Promise<CallResults[R["type"]]>;
  theme: Theme;
  toggleTheme: () => void;
  /** An agent color adjusted to the theme. */
  color: (color: string) => string;
  /** The last error a daemon reported, e.g. a rejected message. */
  error: string | undefined;
}

interface Host {
  state: FleetState;
  info?: DaemonInfo;
  connected: boolean;
}

type Action =
  | { host: string; type: "events"; events: FleetEvent[] }
  | { host: string; type: "snapshot"; state: FleetState }
  | { host: string; type: "info"; info: DaemonInfo }
  | { host: string; type: "connected"; connected: boolean };

function hostsReducer(hosts: Record<string, Host>, action: Action): Record<string, Host> {
  const host = hosts[action.host] ?? { state: emptyState(), connected: false };
  const next = (() => {
    switch (action.type) {
      case "events":
        return { ...host, state: reduceAll(action.events, host.state) };
      case "snapshot":
        return { ...host, state: action.state };
      case "info":
        return { ...host, info: action.info };
      case "connected":
        return { ...host, connected: action.connected };
    }
  })();
  return { ...hosts, [action.host]: next };
}

export const FleetContext = createContext<Fleet | undefined>(undefined);

export function useFleet(): Fleet {
  const fleet = useContext(FleetContext);
  if (!fleet) throw new Error("useFleet outside FleetProvider");
  return fleet;
}

/**
 * Connects to the local daemon and, through it, to every remote one, and applies each
 * daemon's events to a separate state. The browser keeps nothing else: on reconnect each
 * socket asks for the events after the last sequence number it saw.
 */
export function FleetProvider({ children }: { children: ReactNode }) {
  const [hosts, dispatch] = useReducer(hostsReducer, {});
  const [error, setError] = useState<string>();
  const { theme, toggle: toggleTheme } = useTheme();
  const connections = useRef(new Map<string, Connection>());
  const latest = useRef(hosts);
  latest.current = hosts;

  const open = useCallback((host: string, path: string) => {
    const connection = new Connection(path, () => latest.current[host]?.state.lastSeq ?? 0, {
      info: (info) => {
        if (host === LOCAL) reloadIfOutdated(info.build);
        dispatch({ host, type: "info", info });
      },
      snapshot: (state) => dispatch({ host, type: "snapshot", state }),
      events: (events) => dispatch({ host, type: "events", events }),
      error: (message) => setError(host === LOCAL ? message : `${host}: ${message}`),
      connected: (connected) => dispatch({ host, type: "connected", connected }),
    });
    connections.current.set(host, connection);
  }, []);

  useEffect(() => {
    open(LOCAL, "/ws");
    const all = connections.current;
    return () => {
      for (const connection of all.values()) connection.close();
      all.clear();
    };
  }, [open]);

  // The local daemon names the remote ones; it relays each at /remote/<name>/ws.
  const remotes = hosts[LOCAL]?.info?.remotes;
  const remoteKey = remotes?.join("\u0000") ?? "";
  useEffect(() => {
    const wanted = new Set(remoteKey ? remoteKey.split("\u0000") : []);
    for (const [host, connection] of connections.current) {
      if (host !== LOCAL && !wanted.has(host)) {
        connection.close();
        connections.current.delete(host);
      }
    }
    for (const host of wanted) if (!connections.current.has(host)) open(host, `/remote/${host}/ws`);
  }, [remoteKey, open]);

  const remoteNames = useMemo(() => (remoteKey ? remoteKey.split("\u0000") : []), [remoteKey]);
  const state = useMemo(() => {
    const others = Object.fromEntries(
      Object.entries(hosts)
        .filter(([host]) => host !== LOCAL)
        .map(([host, h]) => [host, h.state]),
    );
    return mergeStates(hosts[LOCAL]?.state ?? emptyState(), others);
  }, [hosts]);
  const info = useMemo(() => {
    const local = hosts[LOCAL]?.info;
    if (!local) return undefined;
    const others = Object.fromEntries(
      Object.entries(hosts).flatMap(([host, h]) =>
        host !== LOCAL && h.info ? [[host, h.info]] : [],
      ),
    );
    return mergeInfo(local, others);
  }, [hosts]);

  const send = useCallback(
    (message: Command): void => {
      for (const { host, message: routed } of routeCommand(message, remoteNames)) {
        connections.current.get(host)?.send(routed);
      }
    },
    [remoteNames],
  );
  const call = useCallback(
    <R extends CallRequest>(request: R): Promise<CallResults[R["type"]]> => {
      const { host, call: routed } = routeCall(request, remoteNames);
      const connection = connections.current.get(host);
      if (!connection) return Promise.reject(new Error(`${host} is not connected`));
      return connection.call(routed) as Promise<CallResults[R["type"]]>;
    },
    [remoteNames],
  );
  const color = useCallback((c: string) => themedColor(c, theme), [theme]);

  const value: Fleet = {
    state,
    info,
    connected: hosts[LOCAL]?.connected ?? false,
    offline: remoteNames.filter((host) => !hosts[host]?.connected),
    send,
    call,
    theme,
    toggleTheme,
    color,
    error,
  };
  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

/**
 * Reloads a page older than the web UI the daemon now serves, e.g. after an update; the old
 * page might not speak the new protocol. Once per build, so a mismatch cannot loop.
 */
function reloadIfOutdated(served: number | undefined): void {
  if (!served || served <= __FLEET_BUILD__) return;
  try {
    if (sessionStorage.getItem("fleet.reloadedFor") === String(served)) return;
    sessionStorage.setItem("fleet.reloadedFor", String(served));
  } catch {
    // Without storage the guard is gone; reloading once more is still better than a stale page.
  }
  location.reload();
}

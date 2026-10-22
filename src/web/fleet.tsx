import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { themedColor } from "../shared/colors.ts";
import type { FleetEvent } from "../shared/events.ts";
import type { Call, CallResults, Command, DaemonInfo, ServerMessage } from "../shared/protocol.ts";
import { emptyState, type FleetState, reduceAll } from "../shared/reducer.ts";
import { type Theme, useTheme } from "./useTheme.ts";

type Action = { type: "events"; events: FleetEvent[] } | { type: "snapshot"; state: FleetState };

const apply = (state: FleetState, action: Action): FleetState =>
  action.type === "snapshot" ? action.state : reduceAll(action.events, state);

const MAX_BACKOFF_MS = 10_000;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A call as the caller writes it; the id is added on sending. */
type CallRequest = DistributiveOmit<Call, "id">;
// Request ids only need to be unique per page; crypto.randomUUID is missing outside secure contexts.
let requestCounter = 0;

export interface Fleet {
  state: FleetState;
  info: DaemonInfo | undefined;
  connected: boolean;
  send: (message: Command) => void;
  theme: Theme;
  toggleTheme: () => void;
  /** An agent color adjusted to the theme. */
  color: (color: string) => string;
  /** The last error the daemon reported, e.g. a rejected message. */
  error: string | undefined;
  /** Sends a request to the daemon and resolves with its reply. */
  call: <R extends CallRequest>(request: R) => Promise<CallResults[R["type"]]>;
}

const FleetContext = createContext<Fleet | undefined>(undefined);

export function useFleet(): Fleet {
  const fleet = useContext(FleetContext);
  if (!fleet) throw new Error("useFleet outside FleetProvider");
  return fleet;
}

/**
 * Connects to the daemon and folds its event stream into state. The browser keeps
 * nothing else: on reconnect it asks for events after the last sequence number it saw.
 */
export function FleetProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(apply, undefined, emptyState);
  const [info, setInfo] = useState<DaemonInfo>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const { theme, toggle: toggleTheme } = useTheme();
  const socket = useRef<WebSocket | undefined>(undefined);
  const pending = useRef(
    new Map<string, { resolve: (value: unknown) => void; reject: (e: Error) => void }>(),
  );
  const lastSeq = useRef(0);
  lastSeq.current = state.lastSeq;

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = (): void => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: "subscribe", since: lastSeq.current } satisfies Command));
      };
      ws.onmessage = (message) => {
        const data = JSON.parse(message.data as string) as ServerMessage;
        switch (data.type) {
          case "info":
            setInfo(data.info);
            break;
          case "snapshot":
            dispatch({ type: "snapshot", state: data.state });
            break;
          case "events":
            dispatch({ type: "events", events: data.events });
            break;
          case "error":
            setError(data.message);
            break;
          case "reply": {
            const request = pending.current.get(data.id);
            pending.current.delete(data.id);
            if (data.error === undefined) request?.resolve(data.value);
            else request?.reject(new Error(data.error));
            break;
          }
        }
      };
      ws.onclose = () => {
        setConnected(false);
        // Replies to calls on this socket will never come.
        for (const request of pending.current.values())
          request.reject(new Error("Disconnected from the daemon"));
        pending.current.clear();
        if (closed) return;
        attempt++;
        timer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt));
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, []);

  const send = useCallback((message: Command): void => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);
  const color = useCallback((c: string) => themedColor(c, theme), [theme]);
  const call = useCallback(
    <R extends CallRequest>(request: R) =>
      new Promise<CallResults[R["type"]]>((resolve, reject) => {
        if (socket.current?.readyState !== WebSocket.OPEN) {
          reject(new Error("Not connected to the daemon"));
          return;
        }
        const id = String(++requestCounter);
        pending.current.set(id, {
          resolve: (value) => resolve(value as CallResults[R["type"]]),
          reject,
        });
        socket.current.send(JSON.stringify({ ...request, id }));
      }),
    [],
  );

  return (
    <FleetContext.Provider
      value={{ state, info, connected, send, theme, toggleTheme, color, error, call }}
    >
      {children}
    </FleetContext.Provider>
  );
}

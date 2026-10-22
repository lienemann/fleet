import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { FleetEvent } from "../shared/events.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { emptyState, type FleetState, reduceAll } from "../shared/reducer.ts";

type Action = { type: "events"; events: FleetEvent[] } | { type: "reset" };

const apply = (state: FleetState, action: Action): FleetState =>
  action.type === "reset" ? emptyState() : reduceAll(action.events, state);

const MAX_BACKOFF_MS = 10_000;

export interface Fleet {
  state: FleetState;
  connected: boolean;
  send: (message: ClientMessage) => void;
}

/**
 * Connects to the daemon and folds its event stream into state. The browser keeps
 * nothing else: on reconnect it asks for events after the last sequence number it saw.
 */
export function useFleet(): Fleet {
  const [state, dispatch] = useReducer(apply, undefined, emptyState);
  const [connected, setConnected] = useState(false);
  const socket = useRef<WebSocket | undefined>(undefined);
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
        ws.send(
          JSON.stringify({ type: "subscribe", since: lastSeq.current } satisfies ClientMessage),
        );
      };
      ws.onmessage = (message) => {
        const data = JSON.parse(message.data as string) as ServerMessage;
        if (data.type === "hello" && data.lastSeq < lastSeq.current) {
          // The daemon's log is older than ours (database replaced); it replays from 0.
          dispatch({ type: "reset" });
        } else if (data.type === "events") {
          dispatch({ type: "events", events: data.events });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt++;
        timer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt));
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      socket.current?.close();
    };
  }, []);

  const send = useCallback((message: ClientMessage): void => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  return { state, connected, send };
}

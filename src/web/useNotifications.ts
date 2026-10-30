import { useCallback, useEffect, useRef, useState } from "react";
import { type LowDisk, USER } from "../shared/events.ts";
import {
  type AgentView,
  type FinishedRun,
  type FleetState,
  needsUser,
  pendingDecisions,
} from "../shared/reducer.ts";
import { columnLabel, firstLine, lowDiskText } from "./labels.ts";

const STORAGE_KEY = "fleet.notifications";

export interface Notifications {
  /** On, and the browser allows it. */
  enabled: boolean;
  /** The browser refused; only its site settings can change that. */
  blocked: boolean;
  supported: boolean;
  toggle: () => void;
}

interface Notice {
  /** The agent a click opens. */
  agent?: string;
  /** Replaces an earlier notification with the same tag; the agent's name if not set. */
  tag?: string;
  title: string;
  body: string;
  /** The Finished item it tells of; the notice is outdated once that is read. */
  finished?: string;
}

const readPreference = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
};

const writePreference = (on: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Not remembered across reloads; the toggle still works for this page.
  }
};

/** Whether the user dealt with the item a notice tells of, in this window or another. */
export const outdated = (notice: Notice, state: FleetState): boolean =>
  notice.finished !== undefined &&
  !state.agents[notice.agent ?? ""]?.finished.some((r) => r.id === notice.finished && !r.read);

const diskKey = (volume: LowDisk): string => `${volume.host ?? ""}:${volume.names.join(",")}`;

/** The agent's newest unread Finished item that the earlier state did not have. */
const newFinished = (before: AgentView, after: AgentView): FinishedRun | undefined => {
  const known = new Set(before.finished.map((r) => r.id));
  return after.finished.findLast((r) => !r.read && !known.has(r.id));
};

/**
 * What changed for the user between two states: the moments the "new" mark is set, messages
 * to them, and disks running low. A new Finished item speaks for the mark it sets, unless a
 * decision waits too.
 */
export function notices(before: FleetState, after: FleetState): Notice[] {
  const result: Notice[] = [];
  for (const agent of Object.values(after.agents)) {
    const old = before.agents[agent.name];
    if (!old) continue;
    const finished = newFinished(old, agent);
    const decision = pendingDecisions(after).find((d) => d.agent === agent.name);
    // Every new Finished item is news, whether or not the agent was marked new before.
    if (finished && !decision) {
      result.push({
        agent: agent.name,
        tag: `finished-${agent.name}`,
        title: `${agent.name} ${finished.stopped ? "stopped" : "finished"}`,
        body: firstLine(finished.text),
        finished: finished.id,
      });
      continue;
    }
    if (old.unseen || !agent.unseen) continue;
    if (needsUser(agent)) {
      const what = decision
        ? decision.decision === "permission"
          ? `wants to use ${decision.toolName}`
          : decision.decision === "review"
            ? `asks you to review ${decision.path ?? "a file"}`
            : (decision.questions?.[0]?.question ?? "has a question")
        : "is waiting for your reply";
      result.push({
        agent: agent.name,
        title: `${agent.name} needs you`,
        body: `${agent.title}: ${what}`,
      });
    } else if (agent.task === "review") {
      result.push({
        agent: agent.name,
        title: `${agent.name} is ${columnLabel("review")}`,
        body: agent.report?.summary ?? agent.title,
      });
    } else {
      result.push({
        agent: agent.name,
        title: `${agent.name} wrote something for you`,
        body: agent.title,
      });
    }
  }
  const known = before.messages.at(-1)?.seq ?? 0;
  for (const message of after.messages) {
    if (message.seq > known && message.to === USER) {
      result.push({
        agent: message.from,
        title: `Message from ${message.from}`,
        body: firstLine(message.body),
      });
    }
  }
  // A volume that was fine before; one that stays low does not ask again.
  const wasLow = new Set(before.disk.map(diskKey));
  for (const volume of after.disk) {
    if (!wasLow.has(diskKey(volume))) {
      result.push({ tag: "disk", title: "Disk almost full", body: lowDiskText(volume) });
    }
  }
  return result;
}

/**
 * Desktop notifications for what waits on the user, while fleet is not in front. The browser
 * asks for permission on the first switch-on, which has to come from a click or a key.
 */
export function useNotifications(
  state: FleetState,
  onOpen: (agent: string) => void,
): Notifications {
  const supported = typeof Notification !== "undefined";
  const [wanted, setWanted] = useState(readPreference);
  const [permission, setPermission] = useState(supported ? Notification.permission : "denied");
  const enabled = supported && wanted && permission === "granted";
  const previous = useRef<FleetState | undefined>(undefined);
  const shown = useRef(new Map<Notification, Notice>());
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    // The first state after loading is history, not news.
    if (!enabled || !before || before.lastSeq === 0) return;
    // An item read meanwhile, say by another window that is in front, is no news any more.
    for (const [notification, notice] of shown.current) {
      if (!outdated(notice, state)) continue;
      notification.close();
      shown.current.delete(notification);
    }
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    for (const notice of notices(before, state)) {
      // One notification per agent: a newer one replaces what it said before.
      const notification = new Notification(notice.title, {
        body: notice.body,
        tag: notice.tag ?? notice.agent,
        icon: "/icon-192.png",
      });
      shown.current.set(notification, notice);
      notification.onclose = () => shown.current.delete(notification);
      notification.onclick = () => {
        window.focus();
        if (notice.agent) open.current(notice.agent);
        notification.close();
      };
    }
  }, [state, enabled]);

  const toggle = useCallback(() => {
    if (!supported) return;
    if (wanted) {
      setWanted(false);
      writePreference(false);
      return;
    }
    setWanted(true);
    writePreference(true);
    if (Notification.permission === "default")
      void Notification.requestPermission().then(setPermission);
    else setPermission(Notification.permission);
  }, [supported, wanted]);

  return { enabled, blocked: permission === "denied" && wanted, supported, toggle };
}

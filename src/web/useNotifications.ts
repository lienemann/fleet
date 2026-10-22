import { useCallback, useEffect, useRef, useState } from "react";
import { USER } from "../shared/events.ts";
import { type FleetState, needsUser, pendingDecisions } from "../shared/reducer.ts";
import { columnLabel } from "./labels.ts";

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
  agent: string;
  title: string;
  body: string;
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

/** What changed for the user between two states: the moments the "new" mark is set, and messages to them. */
export function notices(before: FleetState, after: FleetState): Notice[] {
  const result: Notice[] = [];
  for (const agent of Object.values(after.agents)) {
    const old = before.agents[agent.name];
    if (!old || old.unseen || !agent.unseen) continue;
    if (needsUser(agent)) {
      const decision = pendingDecisions(after).find((d) => d.agent === agent.name);
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
      const [first = ""] = message.body.split("\n");
      result.push({ agent: message.from, title: `Message from ${message.from}`, body: first });
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
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    // The first state after loading is history, not news.
    if (!enabled || !before || before.lastSeq === 0) return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    for (const notice of notices(before, state)) {
      // One notification per agent: a newer one replaces what it said before.
      const notification = new Notification(notice.title, {
        body: notice.body,
        tag: notice.agent,
        icon: "/icon-192.png",
      });
      notification.onclick = () => {
        window.focus();
        open.current(notice.agent);
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

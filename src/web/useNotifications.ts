import { useCallback, useEffect, useRef, useState } from "react";
import { type LowDisk, USER } from "../shared/events.ts";
import {
  type AgentView,
  type Decision,
  type FinishedRun,
  type FleetState,
  openPointDocs,
  pendingDecisions,
} from "../shared/reducer.ts";
import type { LineThread } from "../shared/review.ts";
import { type TaskView, taskOf } from "../shared/tasks.ts";
import { agentText } from "./agentStyle.ts";
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

/** A thread of the task with an unread reply that the earlier task did not have. */
const newReply = (before: TaskView | undefined, after: TaskView): LineThread | undefined =>
  after.threads.find((thread) => {
    const old = before?.threads.find((t) => t.id === thread.id);
    return thread.unread && old?.messages.at(-1)?.id !== thread.messages.at(-1)?.id;
  });

const asks = (decision: Decision): string =>
  decision.decision === "permission"
    ? `wants to use ${decision.toolName}`
    : decision.decision === "review"
      ? `asks you to review ${decision.path ?? "a file"}`
      : (decision.questions?.[0]?.question ?? "has a question");

/**
 * What is new for the user about one agent, at most one thing: a decision, else a Finished item,
 * else, unless a message from the agent tells it already, its task going to review, open points
 * or a reply in a thread.
 */
function agentNotice(
  before: FleetState,
  after: FleetState,
  agent: AgentView,
  wrote: boolean,
): Notice | undefined {
  const old = before.agents[agent.name];
  if (!old) return undefined;
  const name = agentText(agent);
  const task = taskOf(after, agent);
  const subject = task?.title ?? agent.title;
  const needs = (what: string): Notice => ({
    agent: agent.name,
    title: `${name} needs you`,
    body: `${subject}: ${what}`,
  });

  const decision = pendingDecisions(after).find(
    (d) => d.agent === agent.name && !before.decisions[d.requestId],
  );
  if (decision) return needs(asks(decision));
  const finished = newFinished(old, agent);
  if (finished) {
    return {
      agent: agent.name,
      tag: `finished-${agent.name}`,
      title: `${name} ${finished.stopped ? "stopped" : "finished"}`,
      body: firstLine(finished.text),
      finished: finished.id,
    };
  }
  if (wrote) return undefined;
  if (task?.state === "review" && before.tasks[task.id]?.state !== "review") {
    return {
      agent: agent.name,
      title: `${name} is ${columnLabel("review")}`,
      body: task.report?.summary ?? subject,
    };
  }
  const points = openPointDocs(after).find(
    (doc) => doc.agent === agent.name && before.openPoints[doc.docId]?.seq !== doc.seq,
  );
  if (points) {
    const open = points.points.filter((p) => p.answer === undefined).length;
    return needs(`${open} open ${open === 1 ? "point" : "points"}`);
  }
  const reply = task && newReply(before.tasks[task.id], task);
  return reply && needs(`replied on ${reply.path}`);
}

/**
 * What changed for the user between two states: each new reason for an agent's Needs you mark,
 * a task that went to review, messages to the user, and disks running low.
 */
export function notices(before: FleetState, after: FleetState): Notice[] {
  const known = before.messages.at(-1)?.seq ?? 0;
  const toUser = after.messages.filter((m) => m.seq > known && m.to === USER);
  const result = Object.values(after.agents).flatMap((agent) => {
    const wrote = toUser.some((m) => m.from === agent.name);
    return agentNotice(before, after, agent, wrote) ?? [];
  });
  for (const message of toUser) {
    const sender = after.agents[message.from];
    result.push({
      agent: message.from,
      title: `Message from ${sender ? agentText(sender) : message.from}`,
      body: firstLine(message.body),
    });
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

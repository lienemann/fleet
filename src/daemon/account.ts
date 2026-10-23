import {
  type AgentEvent,
  EFFORT_LEVELS,
  type EffortLevel,
  type ModelChoice,
  type Usage,
  type UsageLimit,
} from "../shared/events.ts";
import type { QueryFn } from "./session.ts";

/**
 * The SDK's call for what /usage shows. It says itself that it may change, so its reply is
 * read defensively and fleet does without it when it is gone.
 */
export const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

/** How often the daemon looks at the subscription's usage. */
export const ACCOUNT_POLL_MS = 5 * 60_000;

/** A probe that hangs, e.g. on a CLI waiting for a login, is given up. */
const PROBE_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The models of `initializationResult().models`. */
export function parseModels(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ModelChoice[] => {
    if (!isObject(entry)) return [];
    const value = str(entry.value);
    if (!value) return [];
    const resolved = str(entry.resolvedModel);
    const efforts = Array.isArray(entry.supportedEffortLevels)
      ? entry.supportedEffortLevels.filter((e): e is EffortLevel =>
          (EFFORT_LEVELS as readonly unknown[]).includes(e),
        )
      : [];
    return [
      { value, label: str(entry.displayName) ?? value, ...(resolved && { resolved }), efforts },
    ];
  });
}

const LIMIT_LABELS: Record<string, string> = { session: "5 h", weekly_all: "week" };

/** The subscription's limits from the usage reply, or undefined without plan limits. */
export function parseUsage(raw: unknown): Usage | undefined {
  if (!isObject(raw) || raw.rate_limits_available !== true || !isObject(raw.rate_limits)) {
    return undefined;
  }
  const { limits, extra_usage: extra } = raw.rate_limits;
  if (!Array.isArray(limits)) return undefined;
  const parsed = limits.flatMap((limit): UsageLimit[] => {
    if (!isObject(limit)) return [];
    const percent = num(limit.percent);
    const kind = str(limit.kind);
    if (percent === undefined || !kind) return [];
    const scope = isObject(limit.scope) && isObject(limit.scope.model) ? limit.scope.model : {};
    const model = str(scope.display_name);
    const label = LIMIT_LABELS[kind] ?? (model ? `week, ${model}` : kind.replace(/_/g, " "));
    const resetsAt = str(limit.resets_at);
    const severity = str(limit.severity);
    return [{ label, percent, ...(resetsAt && { resetsAt }), ...(severity && { severity }) }];
  });
  const usage: Usage = { plan: str(raw.subscription_type), limits: parsed };
  if (isObject(extra) && extra.is_enabled === true) {
    const scale = 10 ** (num(extra.decimal_places) ?? 2);
    const used = num(extra.used_credits);
    const limit = num(extra.monthly_limit);
    if (used !== undefined && limit !== undefined) {
      usage.extra = {
        used: used / scale,
        limit: limit / scale,
        currency: str(extra.currency) ?? "",
      };
    }
  }
  return usage;
}

/**
 * Starts a Claude Code session that never gets a prompt, so no turn runs and no tokens are
 * spent, and asks it for the models it offers and the subscription's usage.
 */
async function probe(queryFn: QueryFn, cwd: string): Promise<AgentEvent | undefined> {
  let release: () => void = () => undefined;
  const prompt = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  const query = queryFn({ prompt, options: { cwd, persistSession: false } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      ask(query),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    query.close();
  }
}

async function ask(query: ReturnType<QueryFn>): Promise<AgentEvent> {
  const init = await query.initializationResult();
  const usageCall = (query as unknown as Json)[USAGE_METHOD];
  const usage =
    typeof usageCall === "function"
      ? await Promise.resolve(usageCall.call(query, { skipBehaviors: true }))
          .then(parseUsage)
          .catch(() => undefined)
      : undefined;
  return { kind: "account", models: parseModels(init.models), usage };
}

/** Keeps the models and the usage in the event log, appending only what changed. */
export class Account {
  private readonly queryFn: QueryFn;
  private readonly emit: (event: AgentEvent) => void;
  private readonly cwd: string;
  private last = "";

  constructor(queryFn: QueryFn, emit: (event: AgentEvent) => void, cwd: string) {
    this.queryFn = queryFn;
    this.emit = emit;
    this.cwd = cwd;
  }

  async refresh(): Promise<void> {
    try {
      const event = await probe(this.queryFn, this.cwd);
      if (!event) return;
      const key = JSON.stringify(event);
      if (key === this.last) return;
      this.last = key;
      this.emit(event);
    } catch (error) {
      console.error("fleet: reading the models and usage failed:", error);
    }
  }
}

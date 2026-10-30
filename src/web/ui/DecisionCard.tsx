import { useMemo, useState } from "react";
import type { DecisionKind } from "../../shared/events.ts";
import type { Answer } from "../../shared/protocol.ts";
import type { AgentView, Decision } from "../../shared/reducer.ts";
import { useAgentDraft } from "../drafts.ts";
import { duration, RISK_LABELS } from "../labels.ts";
import { useNow } from "../useNow.ts";
import { AgentLabel } from "./AgentLabel.tsx";
import { FileBody } from "./FileBody.tsx";
import { ItemActions } from "./ItemActions.tsx";
import { Markdown } from "./Markdown.tsx";
import { Options } from "./Options.tsx";

interface Props {
  decision: Decision;
  /**
   * "card" stands alone in the inbox and names the agent; "strip" sits above a tile's CLI bar and
   * puts the command into its first line; "compact" sits on a board card and keeps only the
   * command and the quick answers.
   */
  variant?: "card" | "strip" | "compact";
  /** Named on cards, with its task and a way to open it; a tile already says whose it is. */
  agent?: AgentView;
  /** What the agent works on: its task's title, else its own. */
  title?: string;
  onOpen?: () => void;
  focused?: boolean;
  onAnswer: (answer: Answer) => void;
}

const KIND_LABELS: Record<DecisionKind, string> = {
  permission: "Permission",
  question: "Question",
  review: "Review",
};

/** A permission prompt, a question or a review request, with the agent's explanation and risk tags. */
export function DecisionCard({
  decision,
  variant = "card",
  agent,
  title = agent?.title,
  onOpen,
  focused,
  onAnswer,
}: Props) {
  const now = useNow();
  const inline = variant !== "card";
  const compact = variant === "compact";
  const subject = subjectOf(decision);
  return (
    <article
      className={`decision ${variant} ${focused ? "focused" : ""}`}
      data-request={decision.requestId}
    >
      <header>
        <span className={`kind kind-${decision.decision}`}>{KIND_LABELS[decision.decision]}</span>
        {agent && (
          <>
            <AgentLabel agent={agent.name} />
            <span className="dim">{title}</span>
            <span className="dim host">· {agent.host}</span>
            <span className="spacer" />
            <span className="dim">waiting {duration(now - decision.ts)}</span>
            {onOpen && (
              <button type="button" className="link accent" onClick={onOpen}>
                Open
              </button>
            )}
          </>
        )}
        {inline && (
          <code className="subject">
            {decision.decision === "permission" && decision.toolName !== "ExitPlanMode"
              ? `${decision.toolName}(${subject})`
              : subject}
          </code>
        )}
      </header>
      {!inline && decision.decision === "permission" && (
        <pre className="input">
          {decision.toolName === "ExitPlanMode" ? subject : `${decision.toolName}(${subject})`}
        </pre>
      )}
      {decision.explanation &&
        (compact ? (
          <p className="why">{decision.explanation.trim().split("\n")[0]}</p>
        ) : (
          <Markdown text={decision.explanation} className="explanation" />
        ))}
      {!compact && decision.risk.length > 0 && (
        <div className="risks">
          {decision.risk.map((tag) => (
            <span key={tag} className={`risk risk-${tag}`}>
              {RISK_LABELS[tag]}
            </span>
          ))}
        </div>
      )}
      {decision.decision === "question" && (
        <Questions decision={decision} inline={inline} compact={compact} onAnswer={onAnswer} />
      )}
      {!compact && decision.decision === "review" && (
        <Review decision={decision} onAnswer={onAnswer} />
      )}
      {decision.decision === "permission" && <Permission compact={compact} onAnswer={onAnswer} />}
    </article>
  );
}

/** What the decision is about, in one line where possible: the command, the question, the file. */
function subjectOf(decision: Decision): string {
  if (decision.decision === "review") return decision.path ?? "";
  if (decision.decision === "question") {
    const questions = decision.questions ?? [];
    return questions.length === 1
      ? (questions[0]?.question ?? "")
      : `${questions.length} questions`;
  }
  // Leaving plan mode is approving the plan written just above.
  if (decision.toolName === "ExitPlanMode") return "Approve the plan above and start working";
  const command = decision.input.command ?? decision.input.file_path ?? decision.input.url;
  return typeof command === "string" ? command : JSON.stringify(decision.input, null, 2);
}

function Permission({ compact, onAnswer }: Pick<Props, "onAnswer"> & { compact: boolean }) {
  return (
    <ItemActions
      actions={[
        {
          label: "Approve",
          tone: "primary",
          keys: "alt+a",
          run: () => onAnswer({ behavior: "allow" }),
        },
        ...(compact
          ? []
          : [
              {
                label: "Always allow",
                run: () => onAnswer({ behavior: "allow", alwaysAllow: true }),
              },
            ]),
        {
          label: "Reject",
          tone: "danger",
          keys: "alt+r",
          run: () => onAnswer({ behavior: "deny" }),
        },
      ]}
    />
  );
}

/**
 * Options as buttons. A single question with a single choice is answered by its button; several
 * questions or several choices are picked first and sent with Answer. Compact, only the first
 * kind is answered in place.
 */
function Questions({
  decision,
  inline,
  compact,
  onAnswer,
}: Pick<Props, "decision" | "onAnswer"> & { inline: boolean; compact: boolean }) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  // The typed answers are one draft of the decision, one text per question.
  const [typed, setTyped] = useAgentDraft(decision.agent, `answer:${decision.requestId}`);
  const other = useMemo((): Record<string, string> => (typed ? JSON.parse(typed) : {}), [typed]);
  const setOther = (next: Record<string, string>): void =>
    setTyped(Object.values(next).some(Boolean) ? JSON.stringify(next) : "");
  const questions = decision.questions ?? [];
  const answerTo = (question: string): string =>
    other[question]?.trim() || (chosen[question] ?? []).join(", ");
  const complete = questions.every((q) => answerTo(q.question) !== "");
  const oneClick = questions.length === 1 && !questions[0]?.multiSelect;

  const send = (answers: Record<string, string>): void => {
    onAnswer({ behavior: "answers", answers });
    setTyped("");
  };
  const pick = (question: string, label: string, multi: boolean): void => {
    if (oneClick && !other[question]?.trim()) {
      send({ [question]: label });
      return;
    }
    setChosen((prev) => {
      const current = prev[question] ?? [];
      const next = !multi
        ? [label]
        : current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
      return { ...prev, [question]: next };
    });
  };

  if (compact && !oneClick) return null;
  return (
    <>
      {questions.map((q) => (
        <fieldset key={q.question}>
          {/* The strip's first line already asks a single question. */}
          {!(inline && questions.length === 1) && <legend>{q.question}</legend>}
          <Options
            choices={q.options}
            chosen={chosen[q.question] ?? []}
            describe={!inline}
            onPick={(label) => pick(q.question, label, q.multiSelect ?? false)}
          />
          {!compact && (
            <input
              className="other"
              aria-label={`Other answer to: ${q.question}`}
              placeholder="Other answer…"
              value={other[q.question] ?? ""}
              onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
            />
          )}
        </fieldset>
      ))}
      {!compact && (
        <ItemActions
          actions={[
            {
              label: "Answer",
              tone: "primary",
              disabled: !complete,
              run: () =>
                send(Object.fromEntries(questions.map((q) => [q.question, answerTo(q.question)]))),
            },
            { label: "Dismiss", tone: "danger", run: () => onAnswer({ behavior: "deny" }) },
          ]}
        />
      )}
    </>
  );
}

function Review({ decision, onAnswer }: Pick<Props, "decision" | "onAnswer">) {
  const path = decision.path ?? "";
  const [comment, setComment] = useAgentDraft(decision.agent, `review:${decision.requestId}`);
  const message = comment.trim() || undefined;
  const answer = (approved: boolean): void => {
    onAnswer({ behavior: "review", approved, message });
    setComment("");
  };
  return (
    <>
      <p className="review-path">
        {decision.reviewKind} · <code>{path}</code>
      </p>
      <FileBody agent={decision.agent} path={path} className="input file" />
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder="Comments for the agent (needed when asking for changes)"
      />
      <ItemActions
        actions={[
          { label: "Approve", tone: "primary", run: () => answer(true) },
          { label: "Request changes", disabled: !message, run: () => answer(false) },
        ]}
      />
    </>
  );
}

import { type ReactNode, useMemo, useState } from "react";
import type { DecisionKind } from "../../shared/events.ts";
import type { Answer } from "../../shared/protocol.ts";
import type { AgentView, Decision } from "../../shared/reducer.ts";
import { decisionSubject } from "../../shared/replies.ts";
import { itemSlot, useAgentDraft } from "../drafts.ts";
import { duration, RISK_LABELS } from "../labels.ts";
import { useNow } from "../useNow.ts";
import { FileBody } from "./FileBody.tsx";
import { ItemActions } from "./ItemActions.tsx";
import { Markdown } from "./Markdown.tsx";
import { Options } from "./Options.tsx";
import { TaskHead } from "./TaskHead.tsx";

interface Props {
  decision: Decision;
  /**
   * "card" stands alone in the inbox and names the agent; "strip" sits above a tile's CLI bar and
   * puts the command into its first line; "compact" sits on a board card and keeps only the
   * command and the quick answers.
   */
  variant?: "card" | "strip" | "compact";
  /** Named on cards, with its task; a tile already says whose it is. */
  agent?: AgentView;
  focused?: boolean;
  onAnswer: (answer: Answer) => void;
}

const KIND_LABELS: Record<DecisionKind, string> = {
  permission: "Permission",
  question: "Question",
  review: "Review",
};

/** What the comment box asks for, by kind. */
const COMMENT_PLACEHOLDERS: Record<DecisionKind, string> = {
  permission: "Comment for the agent (goes with Approve or Reject)",
  question: "Comment for the agent (goes with Answer or Dismiss)",
  review: "Comments for the agent (needed when asking for changes)",
};

/**
 * A permission prompt, a question or a review request, with the agent's explanation and risk
 * tags. The card and the strip have a comment box, whose text goes with whichever answer the
 * user gives there; the compact variant has none and sends none.
 */
export function DecisionCard({ decision, variant = "card", agent, focused, onAnswer }: Props) {
  const now = useNow();
  const inline = variant !== "card";
  const compact = variant === "compact";
  const subject = decisionSubject(decision);
  const [comment, setComment] = useAgentDraft(decision.agent, itemSlot.comment(decision.requestId));
  const message = compact ? undefined : comment.trim() || undefined;
  const answer = (given: Answer): void => {
    onAnswer(message ? { ...given, message } : given);
    if (message) setComment("");
  };
  const commentBox = !compact && (
    <textarea
      rows={2}
      value={comment}
      onChange={(e) => setComment(e.target.value)}
      aria-label="Comment for the agent"
      placeholder={COMMENT_PLACEHOLDERS[decision.decision]}
    />
  );
  return (
    <article
      className={`decision ${variant} ${focused ? "focused" : ""}`}
      data-request={decision.requestId}
    >
      <header>
        <span className={`kind kind-${decision.decision}`}>{KIND_LABELS[decision.decision]}</span>
        {agent && (
          <>
            <TaskHead task={agent.task} agent={agent.name} />
            <span className="dim host">· {agent.host}</span>
            <span className="spacer" />
            <span className="dim">waiting {duration(now - decision.ts)}</span>
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
        <Questions
          decision={decision}
          inline={inline}
          compact={compact}
          comment={commentBox}
          onAnswer={answer}
        />
      )}
      {!compact && decision.decision === "review" && (
        <Review decision={decision} comment={commentBox} commented={!!message} onAnswer={answer} />
      )}
      {decision.decision === "permission" && (
        <>
          {commentBox}
          <Permission
            decision={decision}
            compact={compact}
            commented={!!message}
            onAnswer={answer}
          />
        </>
      )}
    </article>
  );
}

/** The comment box's text goes with the answer: with Reject as the denial's reason. */
function Permission({
  decision,
  compact,
  commented,
  onAnswer,
}: Pick<Props, "decision" | "onAnswer"> & { compact: boolean; commented: boolean }) {
  return (
    <ItemActions
      actions={[
        {
          label: "Approve",
          tone: "primary",
          keys: "alt+a",
          title: commented ? "Approves, then sends your comment to the agent" : undefined,
          run: () => onAnswer({ behavior: "allow" }),
        },
        ...(compact
          ? []
          : [
              {
                label:
                  decision.alwaysFor === "task" ? "Always allow for this task" : "Always allow",
                run: () => onAnswer({ behavior: "allow", alwaysAllow: true }),
              },
            ]),
        {
          label: "Reject",
          tone: "danger",
          keys: "alt+r",
          title: commented ? "Rejects, with your comment as the reason" : undefined,
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
  comment,
  onAnswer,
}: Pick<Props, "decision" | "onAnswer"> & {
  inline: boolean;
  compact: boolean;
  comment: ReactNode;
}) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  // The typed answers are one draft of the decision, one text per question.
  const [typed, setTyped] = useAgentDraft(decision.agent, itemSlot.answers(decision.requestId));
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
        <>
          {comment}
          <ItemActions
            actions={[
              {
                label: "Answer",
                tone: "primary",
                disabled: !complete,
                run: () =>
                  send(
                    Object.fromEntries(questions.map((q) => [q.question, answerTo(q.question)])),
                  ),
              },
              { label: "Dismiss", tone: "danger", run: () => onAnswer({ behavior: "deny" }) },
            ]}
          />
        </>
      )}
    </>
  );
}

function Review({
  decision,
  comment,
  commented,
  onAnswer,
}: Pick<Props, "decision" | "onAnswer"> & { comment: ReactNode; commented: boolean }) {
  const path = decision.path ?? "";
  return (
    <>
      <p className="review-path">
        {decision.reviewKind} · <code>{path}</code>
      </p>
      <FileBody agent={decision.agent} path={path} className="input file" />
      {comment}
      <ItemActions
        actions={[
          {
            label: "Approve",
            tone: "primary",
            run: () => onAnswer({ behavior: "review", approved: true }),
          },
          {
            label: "Request changes",
            disabled: !commented,
            run: () => onAnswer({ behavior: "review", approved: false }),
          },
        ]}
      />
    </>
  );
}

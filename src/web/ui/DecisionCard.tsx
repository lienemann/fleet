import { useEffect, useState } from "react";
import type { DecisionKind } from "../../shared/events.ts";
import type { Answer } from "../../shared/protocol.ts";
import type { Decision } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { RISK_LABELS } from "../labels.ts";
import { Markdown } from "./Markdown.tsx";

interface Props {
  decision: Decision;
  /**
   * "strip" sits above a tile's CLI bar and puts the command into its first line; "card" stands
   * alone in the inbox and names the agent.
   */
  variant?: "strip" | "card";
  /** Shown on cards; the tile already says whose decision it is. */
  agentColor?: string;
  focused?: boolean;
  onAnswer: (answer: Answer) => void;
}

const KIND_LABELS: Record<DecisionKind, string> = {
  permission: "Permission",
  question: "Question",
  review: "Review",
};

/** A permission prompt, a question or a review request, with the agent's explanation and risk tags. */
export function DecisionCard({ decision, variant = "card", agentColor, focused, onAnswer }: Props) {
  const strip = variant === "strip";
  const subject = subjectOf(decision);
  return (
    <article
      className={`decision ${variant} ${focused ? "focused" : ""}`}
      data-request={decision.requestId}
    >
      <header>
        <span className={`kind kind-${decision.decision}`}>{KIND_LABELS[decision.decision]}</span>
        {agentColor && (
          <strong className="name" style={{ color: agentColor }}>
            {decision.agent}
          </strong>
        )}
        {strip ? (
          <code className="subject">
            {decision.decision === "permission" && decision.toolName !== "ExitPlanMode"
              ? `${decision.toolName}(${subject})`
              : subject}
          </code>
        ) : (
          <span className="tool">{decision.toolName}</span>
        )}
      </header>
      {!strip && decision.decision === "permission" && <pre className="input">{subject}</pre>}
      {decision.explanation && <Markdown text={decision.explanation} className="explanation" />}
      {decision.risk.length > 0 && (
        <div className="risks">
          {decision.risk.map((tag) => (
            <span key={tag} className={`risk risk-${tag}`}>
              {RISK_LABELS[tag]}
            </span>
          ))}
        </div>
      )}
      {decision.decision === "question" && (
        <Questions decision={decision} inline={strip} onAnswer={onAnswer} />
      )}
      {decision.decision === "review" && <Review decision={decision} onAnswer={onAnswer} />}
      {decision.decision === "permission" && <Permission onAnswer={onAnswer} />}
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

function Permission({ onAnswer }: Pick<Props, "onAnswer">) {
  return (
    <footer>
      <button type="button" className="primary" onClick={() => onAnswer({ behavior: "allow" })}>
        Approve <kbd>a</kbd>
      </button>
      <button type="button" onClick={() => onAnswer({ behavior: "allow", alwaysAllow: true })}>
        Always allow
      </button>
      <button type="button" onClick={() => onAnswer({ behavior: "deny" })}>
        Reject <kbd>r</kbd>
      </button>
    </footer>
  );
}

/**
 * Options as buttons. A single question with a single choice is answered by its button; several
 * questions or several choices are picked first and sent with Answer.
 */
function Questions({
  decision,
  inline,
  onAnswer,
}: Pick<Props, "decision" | "onAnswer"> & { inline: boolean }) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const questions = decision.questions ?? [];
  const answerTo = (question: string): string =>
    other[question]?.trim() || (chosen[question] ?? []).join(", ");
  const complete = questions.every((q) => answerTo(q.question) !== "");
  const oneClick = questions.length === 1 && !questions[0]?.multiSelect;

  const send = (answers: Record<string, string>): void =>
    onAnswer({ behavior: "answers", answers });
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

  return (
    <>
      {questions.map((q) => (
        <fieldset key={q.question}>
          {/* The strip's first line already asks a single question. */}
          {!(inline && questions.length === 1) && <legend>{q.question}</legend>}
          <div className="options">
            {q.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className="option"
                aria-pressed={chosen[q.question]?.includes(option.label) ?? false}
                title={option.description}
                onClick={() => pick(q.question, option.label, q.multiSelect ?? false)}
              >
                {option.label}
                {!inline && option.description && <small>{option.description}</small>}
              </button>
            ))}
          </div>
          <input
            className="other"
            aria-label={`Other answer to: ${q.question}`}
            placeholder="Other answer…"
            value={other[q.question] ?? ""}
            onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
          />
        </fieldset>
      ))}
      <footer>
        <button
          type="button"
          className="primary"
          disabled={!complete}
          onClick={() =>
            send(Object.fromEntries(questions.map((q) => [q.question, answerTo(q.question)])))
          }
        >
          Answer
        </button>
        <button type="button" onClick={() => onAnswer({ behavior: "deny" })}>
          Dismiss
        </button>
      </footer>
    </>
  );
}

function Review({ decision, onAnswer }: Pick<Props, "decision" | "onAnswer">) {
  const { call } = useFleet();
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [comment, setComment] = useState("");
  const path = decision.path ?? "";

  useEffect(() => {
    call({ type: "read_file", agent: decision.agent, path }).then(setContent, (e: Error) =>
      setError(e.message),
    );
  }, [call, decision.agent, path]);

  const message = comment.trim() || undefined;
  return (
    <>
      <p className="review-path">
        {decision.reviewKind} · <code>{path}</code>
      </p>
      {content !== undefined && path.endsWith(".md") ? (
        <Markdown text={content} className="input file" />
      ) : (
        <pre className="input file">{error ?? content ?? "Loading…"}</pre>
      )}
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder="Comments for the agent (needed when asking for changes)"
      />
      <footer>
        <button
          type="button"
          className="primary"
          onClick={() => onAnswer({ behavior: "review", approved: true, message })}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={!message}
          onClick={() => onAnswer({ behavior: "review", approved: false, message })}
        >
          Request changes
        </button>
      </footer>
    </>
  );
}

import { useEffect, useState } from "react";
import type { Answer } from "../../shared/protocol.ts";
import type { Decision } from "../../shared/reducer.ts";
import { useFleet } from "../fleet.tsx";
import { RISK_LABELS } from "../labels.ts";

interface Props {
  decision: Decision;
  /** Shown in the inbox; the tile already says whose decision it is. */
  agentColor?: string;
  focused?: boolean;
  onAnswer: (answer: Answer) => void;
}

/** A permission prompt, a question or a review request, with the agent's explanation and risk tags. */
export function DecisionCard({ decision, agentColor, focused, onAnswer }: Props) {
  return (
    <article className={`decision ${focused ? "focused" : ""}`} data-request={decision.requestId}>
      <header>
        {agentColor && <strong style={{ color: agentColor }}>{decision.agent}</strong>}
        <span className="tool">{decision.toolName}</span>
        {decision.risk.map((tag) => (
          <span key={tag} className={`risk risk-${tag}`}>
            {RISK_LABELS[tag]}
          </span>
        ))}
      </header>
      {decision.explanation && <p className="explanation">{decision.explanation}</p>}
      {decision.decision === "question" && <Questions decision={decision} onAnswer={onAnswer} />}
      {decision.decision === "review" && <Review decision={decision} onAnswer={onAnswer} />}
      {decision.decision === "permission" && <Permission decision={decision} onAnswer={onAnswer} />}
    </article>
  );
}

type BodyProps = Pick<Props, "decision" | "onAnswer">;

function Permission({ decision, onAnswer }: BodyProps) {
  // Leaving plan mode is approving the plan written just above.
  const plan = decision.toolName === "ExitPlanMode";
  return (
    <>
      <pre className="input">
        {plan ? "Approve the plan above and start working" : describeInput(decision.input)}
      </pre>
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
    </>
  );
}

function Questions({ decision, onAnswer }: BodyProps) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const questions = decision.questions ?? [];
  const answerTo = (question: string): string =>
    other[question]?.trim() || (chosen[question] ?? []).join(", ");
  const complete = questions.every((q) => answerTo(q.question) !== "");

  const toggle = (question: string, label: string, multi: boolean): void =>
    setChosen((prev) => {
      const current = prev[question] ?? [];
      const next = !multi
        ? [label]
        : current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
      return { ...prev, [question]: next };
    });

  return (
    <>
      {questions.map((q) => (
        <fieldset key={q.question}>
          <legend>{q.question}</legend>
          {q.options.map((option) => (
            <label key={option.label} className="option">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                // The same decision can be on screen twice (inbox and drawer).
                name={`${decision.requestId}:${q.question}`}
                checked={chosen[q.question]?.includes(option.label) ?? false}
                onChange={() => toggle(q.question, option.label, q.multiSelect ?? false)}
              />
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </label>
          ))}
          <input
            className="other"
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
            onAnswer({
              behavior: "answers",
              answers: Object.fromEntries(questions.map((q) => [q.question, answerTo(q.question)])),
            })
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

function Review({ decision, onAnswer }: BodyProps) {
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
      <pre className="input file">{error ?? content ?? "Loading…"}</pre>
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

function describeInput(input: Record<string, unknown>): string {
  const command = input.command ?? input.file_path ?? input.url;
  return typeof command === "string" ? command : JSON.stringify(input, null, 2);
}

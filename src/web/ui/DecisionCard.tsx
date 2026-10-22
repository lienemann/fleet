import { useState } from "react";
import type { Answer } from "../../shared/protocol.ts";
import type { Decision } from "../../shared/reducer.ts";
import { RISK_LABELS } from "../labels.ts";

interface Props {
  decision: Decision;
  /** Shown in the inbox; the tile already says whose decision it is. */
  agentColor?: string;
  focused?: boolean;
  onAnswer: (answer: Answer) => void;
}

/** One permission prompt or question, with the agent's explanation and derived risk tags. */
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
      {decision.decision === "question" && decision.questions ? (
        <Questions decision={decision} onAnswer={onAnswer} />
      ) : (
        <>
          <pre className="input">{describeInput(decision.input)}</pre>
          <footer>
            <button
              type="button"
              className="primary"
              onClick={() => onAnswer({ behavior: "allow" })}
            >
              Approve <kbd>a</kbd>
            </button>
            <button
              type="button"
              onClick={() => onAnswer({ behavior: "allow", alwaysAllow: true })}
            >
              Always allow
            </button>
            <button type="button" onClick={() => onAnswer({ behavior: "deny" })}>
              Reject <kbd>r</kbd>
            </button>
          </footer>
        </>
      )}
    </article>
  );
}

function Questions({ decision, onAnswer }: Pick<Props, "decision" | "onAnswer">) {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const questions = decision.questions ?? [];
  const complete = questions.every((q) => (chosen[q.question]?.length ?? 0) > 0);

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
                name={q.question}
                checked={chosen[q.question]?.includes(option.label) ?? false}
                onChange={() => toggle(q.question, option.label, q.multiSelect ?? false)}
              />
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </label>
          ))}
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
              answers: Object.fromEntries(
                Object.entries(chosen).map(([q, labels]) => [q, labels.join(", ")]),
              ),
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

function describeInput(input: Record<string, unknown>): string {
  const command = input.command ?? input.file_path ?? input.url;
  return typeof command === "string" ? command : JSON.stringify(input, null, 2);
}

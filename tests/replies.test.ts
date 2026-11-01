import { describe, expect, it } from "vitest";
import type { Decision, FinishedRun, Message } from "../src/shared/reducer.ts";
import {
  decisionReference,
  messageReference,
  QUOTE_CHARS,
  runReference,
  withReference,
} from "../src/shared/replies.ts";

/** 14:20 local time, as the references print it. */
const AT = new Date(2026, 9, 31, 14, 20).getTime();

const run = (fields: Partial<FinishedRun> = {}): FinishedRun => ({
  id: "r1",
  endedAt: AT,
  workMs: 60_000,
  text: "\n  Done: the inbox groups runs and messages.\n\nThe rest is styling.",
  read: false,
  ...fields,
});

const decision = (fields: Partial<Decision>): Decision => ({
  requestId: "req-1",
  agent: "alpha",
  decision: "permission",
  toolName: "Bash",
  input: { command: "npm test" },
  explanation: "",
  risk: [],
  seq: 1,
  ts: AT,
  ...fields,
});

describe("references", () => {
  it("name a closing message by its time and task and quote its first line", () => {
    expect(runReference(run({ task: "t23" }))).toBe(
      "Re: your closing message of 14:20 on t23:\n> Done: the inbox groups runs and messages.",
    );
  });

  it("say when the run stopped, and leave out the task when there was none", () => {
    expect(runReference(run({ stopped: "offline" }))).toBe(
      "Re: your last message before you stopped of 14:20:\n> Done: the inbox groups runs and messages.",
    );
  });

  it("cut a long first line", () => {
    const quote = runReference(run({ text: "x".repeat(500) })).split("\n> ")[1] ?? "";
    expect(quote).toHaveLength(QUOTE_CHARS);
    expect(quote.endsWith("…")).toBe(true);
  });

  it("quote nothing for an empty text", () => {
    expect(runReference(run({ text: "  \n" }))).toBe("Re: your closing message of 14:20:");
  });

  it("name a message to the user", () => {
    const message: Message = {
      seq: 7,
      ts: AT,
      from: "alpha",
      to: "user",
      body: "Which port?",
      read: false,
      task: "t3",
    };
    expect(messageReference(message)).toBe("Re: your message of 14:20 on t3:\n> Which port?");
  });

  it("name a permission by its tool and quote the command", () => {
    expect(decisionReference(decision({}), "t4")).toBe(
      "Re: your Bash call of 14:20 on t4:\n> npm test",
    );
  });

  it("name a question and a plan by what they are", () => {
    const question = decision({
      decision: "question",
      questions: [{ question: "Keep the old API?", options: [] }],
    });
    expect(decisionReference(question)).toBe("Re: your question of 14:20:\n> Keep the old API?");
    const plan = decision({ toolName: "ExitPlanMode", input: { plan: "# Plan\n1. Do it" } });
    expect(decisionReference(plan)).toBe("Re: your plan of 14:20:\n> # Plan");
  });

  it("go above the comment", () => {
    expect(withReference("Re: x", "Looks good.")).toBe("Re: x\n\nLooks good.");
  });
});

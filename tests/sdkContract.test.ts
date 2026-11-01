import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USAGE_METHOD } from "../src/daemon/account.ts";
import { TURN_SIGNALS } from "../src/daemon/session.ts";

/** Calls fleet makes on a query that the SDK has but does not declare, so an update may drop them. */
const UNDECLARED = ["getTaskOutput", "askSideQuestion", USAGE_METHOD];

describe("The installed Agent SDK", () => {
  const bundle = readFileSync(
    fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk")),
    "utf8",
  );

  it.each(UNDECLARED)("still has %s", (method) => {
    expect(bundle).toContain(`async ${method}(`);
  });

  it("still knows the setting that passes turn signals on to fleet", () => {
    expect(bundle).toContain(`${TURN_SIGNALS}:`);
  });
});

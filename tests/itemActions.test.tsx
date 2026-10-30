import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { movesOf, removable } from "../src/web/taskMoves.ts";
import { ItemActions } from "../src/web/ui/ItemActions.tsx";

const labels = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, label = ""]) =>
    label.replace(/<[^>]*>/g, "").trim(),
  );

const run = () => {};

describe("ItemActions", () => {
  it("puts the primary action first and the danger one last, behind a gap", () => {
    const html = renderToStaticMarkup(
      <ItemActions
        actions={[
          { label: "Reject", tone: "danger", run },
          { label: "Always allow", run },
          { label: "Approve", tone: "primary", run },
        ]}
      />,
    );
    expect(labels(html)).toEqual(["Approve", "Always allow", "Reject"]);
    expect(html).toMatch(
      /class="primary"[^>]*>Approve.*Always allow.*class="spacer".*class="danger"/,
    );
  });

  it("leaves out the gap when nothing comes before the danger action", () => {
    const html = renderToStaticMarkup(
      <ItemActions actions={[{ label: "Dismiss", tone: "danger", run }]} />,
    );
    expect(html).not.toContain("spacer");
  });

  it("shows the key of the command behind a button, and marks an inactive one without disabling it", () => {
    const html = renderToStaticMarkup(
      <ItemActions actions={[{ label: "Go", keys: "alt+a", inactive: true, title: "why", run }]} />,
    );
    expect(html).toContain("<kbd>");
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(' disabled=""');
  });
});

describe("task moves", () => {
  it("offer the verdict while a task waits for one, in Review and after a revision", () => {
    for (const state of ["review", "changes_requested"] as const)
      expect(movesOf({ state })).toEqual(["accept", "changes"]);
  });

  it("offer what the board offers in the other states, and nothing once a task is final", () => {
    expect(movesOf({ state: "in_progress" })).toEqual(["review"]);
    for (const state of ["queued", "parked", "done", "dropped"] as const) {
      expect(movesOf({ state })).toEqual([]);
    }
  });

  it("let a task be removed until it is done or dropped", () => {
    expect(removable({ state: "review" })).toBe(true);
    expect(removable({ state: "queued" })).toBe(true);
    expect(removable({ state: "done" })).toBe(false);
    expect(removable({ state: "dropped" })).toBe(false);
  });
});

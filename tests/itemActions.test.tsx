import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { keyLabel } from "../src/web/keys/keymap.tsx";
import { movesOf } from "../src/web/taskMoves.ts";
import { ItemActions } from "../src/web/ui/ItemActions.tsx";

/** The buttons' labels, without their keys. */
const labels = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, label = ""]) =>
    label.replace(/<kbd>.*?<\/kbd>/g, "").trim(),
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

  it("shows ⌘↵ alone on the primary action, and the others' own keys", () => {
    const html = renderToStaticMarkup(
      <ItemActions
        actions={[
          { label: "Approve", tone: "primary", keys: "alt+a", run },
          { label: "Reject", tone: "danger", keys: "alt+r", run },
        ]}
      />,
    );
    const submit = `<kbd>${keyLabel("mod+enter")}</kbd>`;
    expect(html).toContain(`Approve ${submit}</button>`);
    expect(html).toContain(`Reject <kbd>${keyLabel("alt+r")}</kbd></button>`);
    expect(html.match(new RegExp(submit.replace(/[+]/g, "\\+"), "g"))).toHaveLength(1);
  });
});

describe("task moves", () => {
  it("offer the verdict and Park while a task waits for one, in Review and after a revision", () => {
    expect(movesOf({ state: "review" })).toEqual(["accept", "changes", "park", "drop"]);
    expect(movesOf({ state: "in_progress", changesRequested: {} })).toEqual([
      "accept",
      "changes",
      "park",
      "drop",
    ]);
  });

  it("park a running task, unpark a parked one, and drop any until it is final", () => {
    expect(movesOf({ state: "in_progress" })).toEqual(["review", "park", "drop"]);
    expect(movesOf({ state: "parked" })).toEqual(["unpark", "drop"]);
    expect(movesOf({ state: "queued" })).toEqual(["drop"]);
    expect(movesOf({ state: "queued", pin: "alpha" })).toEqual(["unpin", "drop"]);
    expect(movesOf({ state: "queued", workspace: "ws1" })).toEqual(["unpin", "drop"]);
    for (const state of ["done", "dropped"] as const) expect(movesOf({ state })).toEqual([]);
  });
});

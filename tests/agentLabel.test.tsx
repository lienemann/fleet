import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NEUTRAL_COLOR, SWATCHES } from "../src/shared/colors.ts";
import type { FleetEvent } from "../src/shared/events.ts";
import type { DaemonInfo, ProjectInfo } from "../src/shared/protocol.ts";
import { emptyState, reduceAll } from "../src/shared/reducer.ts";
import { agentStyle, agentText, projectColorOf } from "../src/web/agentStyle.ts";
import { type Fleet, FleetContext } from "../src/web/fleet.tsx";
import { AgentLabel } from "../src/web/ui/AgentLabel.tsx";
import { worker } from "./helpers.ts";

const project = (name: string, color: string): ProjectInfo => ({
  name,
  color,
  path: `/${name}`,
  defaultWorkspace: name,
  wip: {},
});

const state = reduceAll(
  [
    { ...worker("alpha", { project: "app" }), parent: null, seq: 1, ts: 1 },
    { ...worker("beta", { project: "site" }), parent: null, seq: 2, ts: 2 },
  ] as FleetEvent[],
  emptyState(),
);

/** Renders `node` as the page would with the given projects, in the dark theme. */
const render = (node: ReactNode, projects: ProjectInfo[]): string => {
  const info = { projects } as DaemonInfo;
  const fleet = { state, info, color: (c: string) => c } as Fleet;
  return renderToStaticMarkup(<FleetContext value={fleet}>{node}</FleetContext>);
};

const both = [project("app", SWATCHES[0]), project("site", SWATCHES[1])];

describe("AgentLabel", () => {
  it("names the agent and its project, each in the project's color", () => {
    const html = render(<AgentLabel agent="beta" />, both);
    expect(html).toContain(`style="color:${SWATCHES[1]}">beta</span>`);
    expect(html).toContain(`class="project-chip"`);
    expect(html).toContain(`>site</span>`);
    expect(html).not.toContain(SWATCHES[0]);
  });

  it("leaves the project out while there is only one, unless asked", () => {
    const one = [project("app", SWATCHES[0])];
    expect(render(<AgentLabel agent="alpha" />, one)).not.toContain("project-chip");
    expect(render(<AgentLabel agent="alpha" chip />, one)).toContain("project-chip");
    expect(render(<AgentLabel agent="beta" chip={false} />, both)).not.toContain("project-chip");
  });

  it("opens the agent from its name when it can", () => {
    expect(render(<AgentLabel agent="alpha" onOpen={() => {}} />, both)).toContain("<button");
    expect(render(<AgentLabel agent="alpha" />, both)).not.toContain("<button");
  });

  it("shows an agent that is not known without project or color of its own", () => {
    const html = render(<AgentLabel agent="gone" />, both);
    expect(html).toContain(NEUTRAL_COLOR);
    expect(html).not.toContain("project-chip");
  });
});

describe("project colors in the views' helpers", () => {
  it("looks a project's color up, and falls back to neutral", () => {
    expect(projectColorOf(both, "site")).toBe(SWATCHES[1]);
    expect(projectColorOf(both, undefined)).toBe(NEUTRAL_COLOR);
    expect(projectColorOf(both, "removed")).toBe(NEUTRAL_COLOR);
  });

  it("puts the project into text that has no markup", () => {
    expect(agentText({ name: "alpha", project: "app" })).toBe("alpha · app");
    expect(agentText({ name: "fleet-director" })).toBe("fleet-director");
  });

  it("styles a tile with its project's color at the agent's tint", () => {
    expect(agentStyle({ tint: "medium" }, SWATCHES[2])).toEqual({
      "--project": SWATCHES[2],
      "--tint": "15%",
    });
  });
});

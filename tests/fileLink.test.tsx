import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileLink } from "../src/web/ui/FileLink.tsx";

const row = (missing: boolean) =>
  renderToStaticMarkup(<FileLink cwd="/ws" path="/ws/a.md" missing={missing} onOpen={() => {}} />);

describe("FileLink", () => {
  it("marks a file the viewer found gone, and still offers its path", () => {
    const html = row(true);
    expect(html).toMatch(/class="[^"]*\bmissing\b/);
    expect(html).toContain("deleted");
    expect(html).toContain('aria-label="Copy path"');
  });

  it("shows a file that is there as usual", () => {
    const html = row(false);
    expect(html).not.toContain("missing");
    expect(html).not.toContain("deleted");
  });
});

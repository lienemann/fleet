import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/web/clipboard.ts";
import { CopyPath } from "../src/web/ui/CopyPath.tsx";

afterEach(() => vi.unstubAllGlobals());

/** A page whose selection copy is `execCommand`, as in browsers without the async API. */
function stubDocument(execCommand: () => boolean) {
  const field = { value: "", setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn(), style: {} };
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("document", {
    createElement: () => field,
    body: { append: vi.fn() },
    activeElement: null,
    execCommand,
  });
  return field;
}

describe("copyText", () => {
  it("uses the async clipboard when the page has one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("/a/b.md")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("/a/b.md");
  });

  it("falls back to a selection when the async clipboard is missing or refuses", async () => {
    const field = stubDocument(() => true);
    vi.stubGlobal("navigator", {});
    await expect(copyText("/a/b.md")).resolves.toBe(true);
    expect(field.value).toBe("/a/b.md");
    expect(field.remove).toHaveBeenCalled();

    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await expect(copyText("/c.md")).resolves.toBe(true);
    expect(field.value).toBe("/c.md");
  });

  it("says so when nothing can copy", async () => {
    stubDocument(() => false);
    vi.stubGlobal("navigator", {});
    await expect(copyText("/a")).resolves.toBe(false);
    vi.stubGlobal("document", undefined);
    await expect(copyText("/a")).resolves.toBe(false);
  });
});

describe("CopyPath", () => {
  it("is a button named Copy path", () => {
    const html = renderToStaticMarkup(<CopyPath path="/a/b.md" />);
    expect(html).toMatch(/<button[^>]*aria-label="Copy path"[^>]*title="Copy path"/);
    expect(html).toContain('role="status"');
  });
});

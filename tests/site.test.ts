import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../scripts/site.ts";

let out: string;

beforeAll(() => {
  out = join(mkdtempSync(join(tmpdir(), "fleet-site-")), "site");
  buildSite(out);
});

const pages = () => readdirSync(out).filter((name) => name.endsWith(".html"));

/** What a page makes the browser load: scripts, stylesheets, images, icons and preloads. */
function loads(html: string): string[] {
  const tags = html.match(/<(?:script|img|link)\b[^>]*>/g) ?? [];
  return tags.flatMap((tag) => {
    const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    // A link to the canonical page or an og:image is read by others, not loaded by the browser.
    return url && !/property="og:/.test(tag) ? [url] : [];
  });
}

describe("the homepage", () => {
  it("loads nothing from other servers", () => {
    for (const page of pages()) {
      const html = readFileSync(join(out, page), "utf8");
      expect(
        loads(html).filter((url) => /^(https?:)?\/\//.test(url)),
        page,
      ).toEqual([]);
    }
    const css = readFileSync(join(out, "style.css"), "utf8");
    expect(css).not.toMatch(/url\(["']?(https?:)?\/\//);
  });

  it("has every file its pages and stylesheet ask for", () => {
    const missing: string[] = [];
    for (const page of pages()) {
      const html = readFileSync(join(out, page), "utf8");
      const links = [...html.matchAll(/\bhref="([^"#:]+)"/g)].map((m) => m[1] ?? "");
      for (const url of [...loads(html), ...links]) {
        if (!existsSync(join(out, url))) missing.push(`${page}: ${url}`);
      }
    }
    const css = readFileSync(join(out, "style.css"), "utf8");
    for (const [, url = ""] of css.matchAll(/url\("([^"]+)"\)/g)) {
      if (!existsSync(join(out, url))) missing.push(`style.css: ${url}`);
    }
    expect(missing).toEqual([]);
  });

  it("shows every screenshot that `just screenshots` takes", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    for (const shot of readdirSync(join(out, "screenshots"))) {
      expect(html, shot).toContain(`screenshots/${shot}`);
    }
  });
});

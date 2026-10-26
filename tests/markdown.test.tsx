import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Markdown } from "../src/web/ui/Markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

it("renders tables, lists and highlighted code like the Claude apps", () => {
  const out = html(
    "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n\n```python\ndef f():\n    return 1\n```",
  );
  expect(out).toContain("<table>");
  expect(out).toContain("<li>one</li>");
  expect(out).toContain('class="hljs-keyword"');
});

it("never turns an agent's text into live HTML", () => {
  const out = html('<img src=x onerror="alert(1)"> and [link](javascript:alert(1))');
  expect(out).not.toContain("<img");
  expect(out).not.toContain("javascript:");
});

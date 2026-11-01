import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightBlock } from "../review/highlight.ts";

/**
 * Agent text rendered like the Claude apps do: headings, lists, tables, code with syntax
 * colors. react-markdown builds React elements and ignores raw HTML, so an agent's text
 * cannot inject markup into the page.
 */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const COMPONENTS: ComponentProps<typeof ReactMarkdown>["components"] = {
  // Links open outside the app; relative ones point into the agent's workspace, not this site.
  a: ({ href, children }) =>
    href && /^https?:/.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <code title={href}>{children}</code>
    ),
  code: ({ className, children }) => {
    const language = /language-(\S+)/.exec(className ?? "")?.[1];
    const source = String(children).replace(/\n$/, "");
    if (!language && !source.includes("\n")) return <code>{children}</code>;
    const html = { __html: highlightBlock(source, language) };
    // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes the source text
    return <code className="block" dangerouslySetInnerHTML={html} />;
  },
};

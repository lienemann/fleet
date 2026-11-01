import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";

// Only the languages we review; the full bundle is ten times the size.
const LANGUAGES = {
  bash,
  cpp,
  csharp,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  sh: "bash",
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "csharp",
  go: "go",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  java: "java",
  js: "javascript",
  mjs: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  yml: "yaml",
  yaml: "yaml",
};

export const languageOf = (path: string): string | undefined =>
  BY_EXTENSION[path.split(".").pop()?.toLowerCase() ?? ""];

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * One line as highlighted HTML. Lines are highlighted on their own, so a string or comment
 * spanning lines loses its color after the first; good enough for reading hunks.
 */
export function highlightLine(line: string, language: string | undefined): string {
  if (!language) return escapeHtml(line);
  return hljs.highlight(line, { language, ignoreIllegals: true }).value;
}

/** A whole code block as highlighted HTML; unknown languages stay plain. */
export function highlightBlock(code: string, language: string | undefined): string {
  if (!language || !hljs.getLanguage(language)) return escapeHtml(code);
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

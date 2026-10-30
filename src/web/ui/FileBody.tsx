import { useEffect, useState } from "react";
import type { FileContent } from "../../shared/protocol.ts";
import { isMissingFile } from "../files.ts";
import { useFleet } from "../fleet.tsx";
import { highlightBlock, languageOf } from "../review/highlight.ts";
import { Markdown } from "./Markdown.tsx";

const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KiB`;

/**
 * A file of an agent as the daemon hands it out: Markdown rendered, other text with syntax
 * colors, and a notice for what cannot be shown (binary, too large, refused).
 */
export function FileBody({
  agent,
  path,
  className = "",
  onExists,
}: {
  agent: string;
  path: string;
  className?: string;
  /** Told whether the file is on the disk, once the daemon answered. */
  onExists?: (exists: boolean) => void;
}) {
  const { call } = useFleet();
  const [file, setFile] = useState<FileContent>();
  const [error, setError] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new callback is no reason to read again
  useEffect(() => {
    let current = true;
    setFile(undefined);
    setError(undefined);
    call({ type: "read_file", agent, path }).then(
      (loaded) => {
        if (!current) return;
        setFile(loaded);
        onExists?.(true);
      },
      (e: Error) => {
        if (!current) return;
        setError(e.message);
        if (isMissingFile(e.message)) onExists?.(false);
      },
    );
    return () => {
      current = false;
    };
  }, [call, agent, path]);

  if (error) return <p className={`banner ${className}`}>{error}</p>;
  if (!file) return <p className={`empty ${className}`}>Loading…</p>;
  if (file.kind === "binary")
    return <p className={`empty ${className}`}>Binary file, {kib(file.size)}; not shown.</p>;
  if (file.kind === "too_large")
    return <p className={`empty ${className}`}>Too large to show here: {kib(file.size)}.</p>;
  const text = file.text ?? "";
  if (/\.(md|markdown)$/i.test(path))
    return <Markdown text={text} className={`file-content ${className}`} />;
  const html = { __html: highlightBlock(text, languageOf(path)) };
  return (
    <pre className={`file-content ${className}`}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes the source text */}
      <code dangerouslySetInnerHTML={html} />
    </pre>
  );
}

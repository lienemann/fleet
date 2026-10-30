import { useEffect, useState } from "react";
import { copyText } from "../clipboard.ts";
import { Icon } from "./Icon.tsx";

/** How long "Copied" stays up. */
const FEEDBACK_MS = 1500;

/** A small button that copies a file's absolute path and says so for a moment. */
export function CopyPath({ path }: { path: string }) {
  const [state, setState] = useState<"copied" | "failed">();
  useEffect(() => {
    if (!state) return;
    const timer = setTimeout(() => setState(undefined), FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <>
      <button
        type="button"
        className="copy-path"
        aria-label="Copy path"
        title="Copy path"
        onClick={() => copyText(path).then((ok) => setState(ok ? "copied" : "failed"))}
      >
        <Icon name={state === "copied" ? "check" : "copy"} size={12} />
      </button>
      <span className="copy-feedback" role="status">
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : ""}
      </span>
    </>
  );
}

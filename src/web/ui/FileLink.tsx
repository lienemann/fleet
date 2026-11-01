import { absolutePath, relativeTo } from "../files.ts";
import { CopyPath } from "./CopyPath.tsx";

/** A file of an agent that opens in the drawer's viewer, with a button to copy its path; the full path is the tooltip. */
export function FileLink({
  cwd,
  path,
  note,
  active = false,
  missing = false,
  onOpen,
}: {
  cwd: string;
  path: string;
  note?: string;
  active?: boolean;
  /** The viewer found the file gone from the disk. */
  missing?: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`link file-link ${active ? "active" : ""} ${missing ? "missing" : ""}`}
        title={missing ? `${path} (deleted)` : path}
        onClick={() => onOpen(path)}
      >
        <code>{relativeTo(cwd, path)}</code>
      </button>
      <CopyPath path={absolutePath(cwd, path)} />
      {missing && <span className="dim"> deleted</span>}
      {note && <span className="dim"> {note}</span>}
    </>
  );
}

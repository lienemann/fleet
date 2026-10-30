import { relativeTo } from "../files.ts";

/** A file of an agent that opens in the drawer's viewer; the full path is its tooltip. */
export function FileLink({
  cwd,
  path,
  note,
  active = false,
  onOpen,
}: {
  cwd: string;
  path: string;
  note?: string;
  active?: boolean;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={`link file-link ${active ? "active" : ""}`}
        title={path}
        onClick={() => onOpen(path)}
      >
        <code>{relativeTo(cwd, path)}</code>
      </button>
      {note && <span className="dim"> {note}</span>}
    </>
  );
}

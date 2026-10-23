import type { ReactNode } from "react";
import { VIEWS, type View } from "../views.ts";

/** A view's name and what it shows; controls for the whole view go to the right. */
export function ViewHead({ view, children }: { view: View; children?: ReactNode }) {
  const meta = VIEWS.find((v) => v.id === view);
  return (
    <header className="view-head">
      <h1>
        {meta?.label}
        {view === "history" && <span className="name vcs"> jj</span>}
      </h1>
      <span className="lede">{meta?.lede}</span>
      {children && (
        <>
          <span className="spacer" />
          {children}
        </>
      )}
    </header>
  );
}

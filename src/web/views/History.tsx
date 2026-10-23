import { useEffect, useRef } from "react";

/**
 * jj orbit, proxied by the daemon: the commit graph of all workspaces (classic, lanes or
 * spiral layout), and the operation log with operations to step through and restore.
 */
export function History() {
  const frame = useRef<HTMLIFrameElement>(null);

  // Orbit follows a data-theme on its root, so it takes fleet's theme rather than the system's.
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    const sync = () => {
      const root = iframe.contentDocument?.documentElement;
      const theme = document.documentElement.dataset.theme;
      if (root && theme) root.dataset.theme = theme;
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    iframe.addEventListener("load", sync);
    sync();
    return () => {
      observer.disconnect();
      iframe.removeEventListener("load", sync);
    };
  }, []);

  return (
    <section className="history">
      <iframe ref={frame} src="/orbit/" title="jj orbit: history of the repository" />
    </section>
  );
}

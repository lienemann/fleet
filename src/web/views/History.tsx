/**
 * jj orbit, proxied by the daemon: the commit graph of all workspaces (classic, lanes or
 * spiral layout), and the operation log with operations to step through and restore.
 */
export function History() {
  return (
    <section className="history">
      <iframe src="/orbit/" title="jj orbit: history of the repository" />
    </section>
  );
}

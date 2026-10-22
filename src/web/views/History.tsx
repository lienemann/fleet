/**
 * What happened to the repo? jj orbit, served by the daemon: the commit graph of all
 * workspaces (classic, lanes or spiral), and the op log as checkpoints to scrub and restore.
 */
export function History() {
  return (
    <section className="history">
      <iframe src="/orbit/" title="jj orbit: history of the repository" />
    </section>
  );
}

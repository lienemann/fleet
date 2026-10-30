import { useEffect, useRef, useState } from "react";
import { useLocalProjects, useProjectFilter } from "../projects.tsx";
import { ProjectChip } from "../ui/AgentLabel.tsx";

/**
 * jj orbit, proxied by the daemon: the commit graph of all workspaces of one project's repo
 * (classic, lanes or spiral layout), and the operation log with operations to step through and
 * restore. With several projects, a picker chooses the repo; the filtered project's comes first.
 */
export function History() {
  const frame = useRef<HTMLIFrameElement>(null);
  const projects = useLocalProjects();
  const filter = useProjectFilter();
  const [chosen, setChosen] = useState<string>();
  const project = (projects.find((p) => p.name === (chosen ?? filter.project)) ?? projects[0])
    ?.name;

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
      {projects.length > 1 && (
        <label className="history-pick">
          Project
          <select value={project} onChange={(e) => setChosen(e.target.value)}>
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {p.path}
              </option>
            ))}
          </select>
          {project && <ProjectChip project={project} />}
        </label>
      )}
      <iframe
        ref={frame}
        src={project ? `/orbit/${project}/` : "about:blank"}
        title={`jj orbit: history of ${project ?? "the repository"}`}
      />
    </section>
  );
}

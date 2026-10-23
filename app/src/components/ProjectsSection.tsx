import { useState } from "react";
import { fetchProjectGit } from "../api";
import { routeHash } from "../routes";
import type { ProjectGit, ProjectInfo } from "../types";
import { useProjects } from "../useProjects";

const BRANCHES_SHOWN = 6;

/** One line on where the checkout stands: `main · clean · 1 ahead, 2
 *  behind`. Ahead/behind are as of the repo's last fetch. */
export function gitLine(status: ProjectGit["status"]): string {
  const parts = [status.detached ? `detached at ${status.branch}` : status.branch];
  parts.push(status.dirty ? `${status.changedFiles} changed file${status.changedFiles === 1 ? "" : "s"}` : "clean");
  if (!status.hasUpstream) parts.push("no upstream");
  else if (status.ahead || status.behind) parts.push(`${status.ahead ?? 0} ahead, ${status.behind ?? 0} behind`);
  return parts.join(" · ");
}

/** The Board screen's Projects section: each registered project, open
 *  to its branches and cards grouped by ticket. Read only; the git
 *  state loads when a project is opened, and Refresh reads it again. */
export function ProjectsSection() {
  const projects = useProjects();
  if (projects.length === 0) return null;
  return (
    <section className="lane lane-projects" aria-labelledby="lane-projects" data-lane="projects">
      <h2 id="lane-projects">
        Projects <span className="count">{projects.length}</span>
      </h2>
      <ul className="task-list">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </ul>
    </section>
  );
}

function ProjectRow({ project }: { project: ProjectInfo }) {
  const [open, setOpen] = useState(false);
  const [git, setGit] = useState<ProjectGit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setGit(await fetchProjectGit(project.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !git && !busy) void load();
  }

  return (
    <li className="project-item" data-project-id={project.id}>
      <button type="button" className="project-head" aria-expanded={open} onClick={toggle}>
        <span className="task-text">
          <span className="task-title">{project.name}</span>
          <span className="task-sub">{git ? gitLine(git.status) : open && busy ? "Reading…" : project.path}</span>
        </span>
      </button>
      {open && (
        <div className="project-body">
          {error && (
            <p className="error" role="alert">
              Could not read {project.name}: {error}
            </p>
          )}
          {git && <ProjectTickets git={git} />}
          <button type="button" className="link-btn" disabled={busy} onClick={() => void load()}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
          {git && <p className="task-sub">As of this checkout's last fetch.</p>}
        </div>
      )}
    </li>
  );
}

function ProjectTickets({ git }: { git: ProjectGit }) {
  if (git.tickets.length === 0) return <p className="empty">No branches.</p>;
  return (
    <div className="project-tickets">
      {git.tickets.map((t) => (
        <div key={t.key ?? "none"} className="ticket-group" data-ticket={t.key ?? ""}>
          <h3 className="ticket-key mono">{t.key ?? "No ticket"}</h3>
          {t.cards.length > 0 && (
            <ul className="ticket-cards">
              {t.cards.map((c) => (
                <li key={c.id}>
                  <a href={routeHash({ screen: "board", taskId: c.id })}>{c.title || c.id.slice(0, 8)}</a> <span className="pill">{c.status}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="task-sub mono">
            {t.branches.slice(0, BRANCHES_SHOWN).join(", ")}
            {t.branches.length > BRANCHES_SHOWN && ` +${t.branches.length - BRANCHES_SHOWN} more`}
          </p>
          {t.worktrees.length > 0 && (
            <p className="task-sub">
              {t.worktrees.length} worktree{t.worktrees.length === 1 ? "" : "s"} open
            </p>
          )}
        </div>
      ))}
      {git.truncated && <p className="task-sub">Newest branches only.</p>}
    </div>
  );
}

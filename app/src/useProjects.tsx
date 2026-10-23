import { createContext, useContext, useEffect, useState } from "react";
import { fetchProjects } from "./api";
import type { ProjectInfo } from "./types";

// The registered projects (GET /projects), loaded once by the shell:
// they name the ticket patterns a card's repo uses. Until it answers
// (or if it fails) a card shows no ticket chip, nothing else changes.

export const ProjectsContext = createContext<readonly ProjectInfo[]>([]);

export function useProjects(): readonly ProjectInfo[] {
  return useContext(ProjectsContext);
}

export function useProjectsLoader(): readonly ProjectInfo[] {
  const [projects, setProjects] = useState<readonly ProjectInfo[]>([]);
  useEffect(() => {
    let live = true;
    fetchProjects().then(
      (list) => live && setProjects(list),
      () => {
        // No chips without the list.
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return projects;
}

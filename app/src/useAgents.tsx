import { createContext, useContext, useEffect, useState } from "react";
import { fetchAgents } from "./api";
import type { AgentInfo } from "./types";

// The manifest's agents (GET /agents) for names and personas, loaded
// once by the shell: the manifest only changes with a server restart.
// Until it answers (or if it fails) every agent still has a face, the
// one derived from its id (persona.ts).

export type Agents = ReadonlyMap<string, AgentInfo>;

export const AgentsContext = createContext<Agents>(new Map());

export function useAgents(): Agents {
  return useContext(AgentsContext);
}

export function useAgentsLoader(): Agents {
  const [agents, setAgents] = useState<Agents>(new Map());
  useEffect(() => {
    let live = true;
    fetchAgents().then(
      (list) => live && setAgents(new Map(list.map((a) => [a.id, a]))),
      () => {
        // Derived faces still work without the manifest.
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

/** The manifest name, else the id. */
export function agentName(agents: Agents, id: string): string {
  return agents.get(id)?.name ?? id;
}

export interface SessionHandle {
  id: string;
  kind: "tmux" | "process";
  cwd: string;
}

/** Swappable: tmux locally, container elsewhere. */
export interface SessionSupervisor {
  spawn(cwd: string, command: string[], env: Record<string, string>): Promise<SessionHandle>;
  healthy(handle: SessionHandle): Promise<boolean>;
  kill(handle: SessionHandle): Promise<void>;
}

export class TmuxSupervisor implements SessionSupervisor {
  async spawn(): Promise<SessionHandle> {
    throw new Error("not implemented");
  }
  async healthy(): Promise<boolean> {
    throw new Error("not implemented");
  }
  async kill(): Promise<void> {
    throw new Error("not implemented");
  }
}

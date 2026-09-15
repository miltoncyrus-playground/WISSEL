/**
 * Worktree lifecycle. Resolves the ORIGIN repo path, never the worktree
 * path — this is what keeps per-repo memory scoping correct.
 */
export interface WorktreeHandle {
  id: string;
  path: string;
  originRepo: string;
  branch: string;
}

export class WorktreeService {
  constructor(private root: string) {}

  async create(repo: string, taskId: string): Promise<WorktreeHandle> {
    void repo;
    void taskId;
    void this.root;
    throw new Error("not implemented");
  }

  async destroy(handle: WorktreeHandle): Promise<void> {
    void handle;
    throw new Error("not implemented");
  }

  /** Remove worktrees with no live session and no unpushed work. */
  async gc(): Promise<string[]> {
    throw new Error("not implemented");
  }
}

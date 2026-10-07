// The contract between this bundle and the page that mounts it: the
// board shell (src/api/public/board.html, "Pipeline editor" section) or
// the dev harness (index.html). See main.tsx's mountPipelineEditor.

/** Which pipeline the editor shows: a new draft (`#/pipelines/new`) or a
 *  saved one (`#/pipelines/edit/<id>`). */
export type EditorRoute = { mode: "new" } | { mode: "edit"; pipelineId: string };

export interface EditorHost {
  /** The editor moved itself to `route` (a first Save of a new
   *  pipeline). The host updates the address bar without remounting. */
  setRoute(route: EditorRoute): void;
  /** Start a run of this saved pipeline. The board opens its "+ New"
   *  drawer on the Pipeline run tab with it picked. */
  runPipeline(pipelineId: string): void;
}

export interface MountOptions {
  route: EditorRoute;
  host: EditorHost;
  /** A new key starts a fresh editor (unsaved state is dropped). */
  key?: string;
}

export interface EditorHandle {
  update(options: MountOptions): void;
  unmount(): void;
}

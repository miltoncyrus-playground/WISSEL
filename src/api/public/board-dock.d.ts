// Types for board-dock.js, for bun test (see its module.exports guard).
export const DOCK_STORAGE_KEY: string;
export interface DockState {
  open: boolean;
  workstreamId?: string;
}
export function dockSrc(workstreamId?: string): string;
export function readDockState(storage: Pick<Storage, "getItem"> | undefined): DockState;
export function writeDockState(storage: Pick<Storage, "setItem"> | undefined, state: DockState): void;
export function workstreamOfHash(hash: string | undefined): string | undefined;
export function initCoordinatorDock(doc: Document, win: Window): void;

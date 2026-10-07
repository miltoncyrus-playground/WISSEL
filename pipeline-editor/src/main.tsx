import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import flowCss from "@xyflow/react/dist/style.css?inline";
import editorCss from "./index.css?inline";
import { App } from "./App";
import type { EditorHandle, MountOptions } from "./host";

export type { EditorHandle, EditorHost, EditorRoute, MountOptions } from "./host";

const STYLE_ID = "pipeline-editor-styles";

// The board imports this file as a plain ES module (no <link> tags), so
// the styles travel inside it and go into <head> once, on first mount.
function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${flowCss}\n${editorCss}`;
  document.head.appendChild(style);
}

/** Mounts the editor into `el` (docs/SDD-ui-cleanup.md §4.2). The board
 *  shell calls this from board.html's showPipelineEditor; `update`
 *  re-renders with a new route, and a new `key` starts a fresh editor. */
export function mountPipelineEditor(el: HTMLElement, options: MountOptions): EditorHandle {
  injectStyles();
  const root = createRoot(el);
  const render = (opts: MountOptions) => {
    root.render(
      <StrictMode>
        <App key={opts.key ?? editorKey(opts)} route={opts.route} host={opts.host} />
      </StrictMode>,
    );
  };
  render(options);
  return {
    update: render,
    unmount: () => root.unmount(),
  };
}

function editorKey(opts: MountOptions): string {
  return opts.route.mode === "edit" ? `edit:${opts.route.pipelineId}` : "new";
}

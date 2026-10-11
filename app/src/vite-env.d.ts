/// <reference types="vite/client" />

/** A board browser script loaded through vite.config.ts's
 *  browserScript plugin: its `module.exports`. app/src/news.ts types it. */
declare module "*?browser-script" {
  const exports: unknown;
  export default exports;
}

/**
 * Board API. One SSE stream per board carries card moves, routing
 * decisions and session output, so a 2-second readonly agent and a
 * 20-minute worktree agent share one rendering path in the frontend.
 */
const port = Number(process.env.WISSEL_PORT ?? 8787);

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    return new Response("not implemented", { status: 501 });
  },
});

console.log(`wissel board api on :${port}`);

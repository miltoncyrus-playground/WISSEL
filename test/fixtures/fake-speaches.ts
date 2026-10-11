// A fake speaches (docs/SDD-wissel-app.md §3.5): the two endpoints
// src/services/stt.ts calls, `GET /health` and `POST
// /v1/audio/transcriptions`, answering however a test sets `mode`. Used
// by the gate tests and, through e2e/fixtures/fake-stt-server.ts, by the
// Playwright server. Never the real model.

export type FakeSttMode = "ok" | "long" | "silent" | "http500" | "not-json" | "no-text" | "no-model" | "slow" | "health500";

export interface FakeSttRequest {
  model: string | null;
  responseFormat: string | null;
  language: string | null;
  filename: string | null;
  type: string | null;
  bytes: number;
}

export interface FakeSpeaches {
  url: string;
  port: number;
  mode: FakeSttMode;
  /** What "ok" answers with. */
  text: string;
  durationSeconds: number;
  /** How long "slow" takes, in ms. */
  slowMs: number;
  /** When set, "ok" answers with this for the uploaded file's name. */
  textFor?: (filename: string) => string;
  requests: FakeSttRequest[];
  healthChecks: number;
  stop(): void;
}

export function startFakeSpeaches(opts: { port?: number; text?: string } = {}): FakeSpeaches {
  const state: FakeSpeaches = {
    url: "",
    port: 0,
    mode: "ok",
    text: opts.text ?? "Create a card to check the README.",
    durationSeconds: 3.2,
    slowMs: 1500,
    requests: [],
    healthChecks: 0,
    stop: () => {},
  };
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") {
        state.healthChecks++;
        // speaches answers a plain "OK".
        return state.mode === "health500" ? new Response("boom", { status: 500 }) : new Response("OK");
      }
      // For e2e: what the last upload looked like, and a way to set the mode.
      if (path === "/fake/last") return Response.json(state.requests.at(-1) ?? null);
      if (path === "/fake/mode" && req.method === "POST") {
        const body = (await req.json()) as { mode?: FakeSttMode; text?: string };
        if (body.mode) state.mode = body.mode;
        if (typeof body.text === "string") state.text = body.text;
        return Response.json({ mode: state.mode, text: state.text });
      }
      if (path === "/v1/audio/transcriptions" && req.method === "POST") {
        const form = await req.formData();
        const file = form.get("file");
        state.requests.push({
          model: form.get("model") as string | null,
          responseFormat: form.get("response_format") as string | null,
          language: form.get("language") as string | null,
          filename: file && typeof file !== "string" ? (file as File).name : null,
          type: file && typeof file !== "string" ? file.type : null,
          bytes: file && typeof file !== "string" ? file.size : 0,
        });
        switch (state.mode) {
          case "http500":
            return new Response("Internal Server Error", { status: 500 });
          case "not-json":
            return new Response("<html>proxy error</html>", { headers: { "content-type": "text/html" } });
          case "no-text":
            return Response.json({ duration: 2 });
          case "no-model":
            return Response.json({ detail: "Model 'Systran/faster-whisper-small' is not installed locally." }, { status: 404 });
          case "long":
            return Response.json({ text: "a very long note", duration: 400, language: "en" });
          case "silent":
            return Response.json({ text: "  ", duration: 2, language: "en" });
          case "slow":
            await Bun.sleep(state.slowMs);
            break;
        }
        const name = file && typeof file !== "string" ? (file as File).name : "";
        const text = state.textFor ? state.textFor(name) : state.text;
        return Response.json({ task: "transcribe", text: ` ${text}`, duration: state.durationSeconds, language: "en", segments: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.port = server.port!;
  state.url = `http://127.0.0.1:${server.port}`;
  state.stop = () => server.stop(true);
  return state;
}

// Voice notes and spoken replies for Ask (docs/SDD-wissel-app.md §3.5).
// No React and no DOM globals: the browser bits (getUserMedia,
// MediaRecorder, timers) come in as arguments, so app/test/voice.test.ts
// drives them with fakes.
//
// Two ways in. The board is served over plain HTTP on the LAN, where
// getUserMedia does not exist, so the mic button opens the phone's own
// recorder through <input type="file" accept="audio/*" capture>. Where
// getUserMedia does exist (localhost, or HTTPS later) it records in the
// page instead, and stops by itself at 5 minutes.

import type { ChatMessage } from "./types";
import type { Track } from "./player";

/** The server's caps (src/services/stt.ts). */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 5 * 60;

/** True when the page can record by itself. */
export function canRecordInPage(env: { mediaDevices?: { getUserMedia?: unknown } | undefined; MediaRecorder?: unknown }): boolean {
  return typeof env.mediaDevices?.getUserMedia === "function" && typeof env.MediaRecorder === "function";
}

/** The first type the browser's MediaRecorder can make, Opus first
 *  (small, and what speaches reads best); "" lets the browser pick. */
export function pickRecorderType(isTypeSupported: ((t: string) => boolean) | undefined): string {
  const wanted = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
  if (!isTypeSupported) return "";
  return wanted.find((t) => {
    try {
      return isTypeSupported(t);
    } catch {
      return false;
    }
  }) ?? "";
}

/** "voice-note.webm" for a recording of `type`. */
export function recordingName(type: string): string {
  const base = type.split(";")[0]!.trim();
  const ext = base === "audio/ogg" ? "ogg" : base === "audio/mp4" ? "m4a" : base === "audio/mpeg" ? "mp3" : "webm";
  return `voice-note.${ext}`;
}

/** Why a picked file can't be sent, or null. `durationSeconds` is what
 *  the browser read from it, when it could (a recorder's WebM often
 *  reports none). */
export function voiceFileProblem(file: { size: number; type: string }, durationSeconds?: number): string | null {
  if (file.size === 0) return "That recording is empty.";
  if (file.size > MAX_VOICE_BYTES) return `That recording is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`;
  if (file.type && !/^(audio|video)\//i.test(file.type) && file.type !== "application/octet-stream") return "That file isn't audio.";
  if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > MAX_VOICE_SECONDS + 5) {
    return `That recording is ${clock(durationSeconds)} long. The limit is 5:00.`;
  }
  return null;
}

/** "1:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The draft with a transcript added: on its own when the box is empty,
 *  after a space otherwise. Nothing is sent: Milton reads it first. */
export function withTranscript(draft: string, text: string): string {
  const t = text.trim();
  if (!t) return draft;
  if (!draft.trim()) return t;
  return /\s$/.test(draft) ? `${draft}${t}` : `${draft} ${t}`;
}

/** A concierge reply as a track for the shell's one player. */
export function replyTrack(message: Pick<ChatMessage, "id" | "text">, audioUrl: string): Track {
  const first = message.text.split("\n").find((l) => l.trim())?.trim() ?? "Reply";
  return {
    runId: `reply-${message.id}`,
    title: first.length > 80 ? `${first.slice(0, 79)}…` : first,
    pipelineName: "wissel reply",
    audioUrl,
    link: "#/ask",
  };
}

// ---------- In-page recording ----------

/** The parts of MediaRecorder the recorder uses. */
export interface MediaRecorderLike {
  readonly mimeType: string;
  readonly state: string;
  start(timeslice?: number): void;
  stop(): void;
  addEventListener(type: "dataavailable", fn: (e: { data: Blob }) => void): void;
  addEventListener(type: "stop" | "error", fn: () => void): void;
}

export interface StreamLike {
  getTracks(): { stop(): void }[];
}

export interface RecorderDeps {
  getUserMedia: (c: { audio: true }) => Promise<StreamLike>;
  createRecorder: (stream: StreamLike, mimeType: string) => MediaRecorderLike;
  mimeType: string;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  maxSeconds?: number;
}

export interface Recording {
  blob: Blob;
  name: string;
  seconds: number;
  /** Stopped by the 5 minute cap, not by Milton. */
  capped: boolean;
}

export interface Recorder {
  /** Asks for the mic and starts. Rejects with a message to show. */
  start(): Promise<void>;
  /** Stops and resolves with the note. */
  stop(): Promise<Recording>;
  /** Stops and throws the note away. */
  cancel(): void;
  /** Seconds since start. */
  elapsed(): number;
  /** Resolves when the cap stops the recording by itself. */
  onCapped(fn: (r: Recording) => void): void;
}

/** The message for a getUserMedia failure. */
export function micError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "The browser blocked the microphone. Allow it, or pick a recording instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return "Could not start recording.";
}

export function createRecorder(deps: RecorderDeps): Recorder {
  const now = deps.now ?? Date.now;
  const set = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const maxSeconds = deps.maxSeconds ?? MAX_VOICE_SECONDS;
  let stream: StreamLike | null = null;
  let rec: MediaRecorderLike | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let cap: unknown = null;
  let capped = false;
  let cancelled = false;
  let finished: Promise<Recording> | null = null;
  let cappedFn: ((r: Recording) => void) | null = null;

  const release = () => {
    if (cap !== null) clear(cap);
    cap = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };

  function finish(): Promise<Recording> {
    if (finished) return finished;
    finished = new Promise<Recording>((resolve, reject) => {
      if (!rec) {
        reject(new Error("Not recording."));
        return;
      }
      const r = rec;
      const seconds = (now() - startedAt) / 1000;
      r.addEventListener("stop", () => {
        release();
        const type = r.mimeType || deps.mimeType || "audio/webm";
        resolve({ blob: new Blob(chunks, { type }), name: recordingName(type), seconds, capped });
      });
      if (r.state === "inactive") {
        release();
        const type = r.mimeType || deps.mimeType || "audio/webm";
        resolve({ blob: new Blob(chunks, { type }), name: recordingName(type), seconds, capped });
      } else r.stop();
    });
    return finished;
  }

  return {
    async start() {
      try {
        stream = await deps.getUserMedia({ audio: true });
      } catch (err) {
        throw new Error(micError(err));
      }
      // Cancelled while the permission prompt was open (Ask unmounted):
      // let the mic go and never start a recorder nobody holds.
      if (cancelled) {
        release();
        throw new Error("Recording cancelled.");
      }
      try {
        rec = deps.createRecorder(stream, deps.mimeType);
      } catch {
        release();
        throw new Error("This browser can't record audio here. Pick a recording instead.");
      }
      chunks = [];
      rec.addEventListener("dataavailable", (e) => {
        if (!cancelled && e.data && e.data.size > 0) chunks.push(e.data);
      });
      rec.addEventListener("error", () => release());
      startedAt = now();
      // A slice a second, so a crash mid-note still has most of it.
      rec.start(1000);
      cap = set(() => {
        capped = true;
        void finish().then((r) => cappedFn?.(r));
      }, maxSeconds * 1000);
    },
    stop: finish,
    cancel() {
      cancelled = true;
      if (rec && rec.state !== "inactive") rec.stop();
      release();
    },
    elapsed: () => (startedAt ? (now() - startedAt) / 1000 : 0),
    onCapped(fn) {
      cappedFn = fn;
    },
  };
}

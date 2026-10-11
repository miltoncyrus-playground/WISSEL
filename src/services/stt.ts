/**
 * Speech to text for Ask's voice notes (docs/SDD-wissel-app.md §3.5):
 * the local speaches service (faster-whisper behind an OpenAI-compatible
 * `POST /v1/audio/transcriptions`) at `WISSEL_STT_URL`. Same shape as
 * TtsExecutor (src/executors/tts.ts): one health check first, a timeout
 * on the whole request, and every failure is an SttError whose message
 * says what broke and where, never a guess at the text.
 *
 * A local model behind HTTP, not a hosted API. No LLM, no harness.
 */

export const DEFAULT_STT_URL = "http://127.0.0.1:8000";
/** Fits this machine's i5-4308U on CPU (int8); `Systran/faster-whisper-base`
 *  if it turns out too slow (WISSEL_STT_MODEL). */
export const DEFAULT_STT_MODEL = "Systran/faster-whisper-small";
/** A voice note is at most this big... */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;
/** ...and this long. */
export const MAX_VOICE_SECONDS = 5 * 60;
/** A recorder's own length can run a little over what it was told. */
const DURATION_SLACK_SECONDS = 5;
/** small int8 on this 2-core CPU runs at roughly real time, so a 5
 *  minute note can take about 5 minutes. Double that before giving up. */
export const DEFAULT_STT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/** HTTP status the server answers with: 413 too big or too long, 415 not
 *  audio, 422 no speech heard, 502 speaches answered wrong, 503 not
 *  reachable, 504 too slow. */
export type SttStatus = 400 | 413 | 415 | 422 | 502 | 503 | 504;

export class SttError extends Error {
  constructor(
    message: string,
    readonly status: SttStatus,
  ) {
    super(message);
  }
}

export interface Transcript {
  text: string;
  /** Seconds of audio, when speaches reports it (verbose_json). */
  durationSeconds?: number;
  language?: string;
  model: string;
  /** How long speaches took. */
  transcribeSeconds: number;
}

export interface SttClientOptions {
  /** speaches base URL (`WISSEL_STT_URL`). */
  baseUrl?: string;
  /** Whisper model id (`WISSEL_STT_MODEL`). */
  model?: string;
  /** ISO 639-1 code (`WISSEL_STT_LANGUAGE`); unset lets Whisper detect it. */
  language?: string;
  timeoutMs?: number;
  healthTimeoutMs?: number;
}

/** "audio/webm;codecs=opus" -> true. A phone's recorder can label its
 *  file `video/mp4` or `video/webm` (an audio-only container all the
 *  same), and some leave the type empty; anything else is refused. */
export function isAudioType(type: string): boolean {
  const t = type.split(";")[0]!.trim().toLowerCase();
  return t === "" || t === "application/octet-stream" || t.startsWith("audio/") || t === "video/webm" || t === "video/mp4" || t === "video/3gpp" || t === "video/ogg";
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "video/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/3gpp": "3gp",
  "video/3gpp": "3gp",
  "audio/amr": "amr",
  "audio/flac": "flac",
};

/** The name the note is sent under. Multipart parts are typed by their
 *  file name on the way through (Bun does this), so a name with no
 *  extension gets one from the note's type. Only the base name is kept. */
export function noteFileName(name: string, type: string): string {
  const base = (name.split(/[\\/]/).pop() || "").replace(/[^\w.-]+/g, "_").slice(-100) || "voice-note";
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const ext = EXTENSIONS[type.split(";")[0]!.trim().toLowerCase()];
  return ext ? `${base}.${ext}` : base;
}

/** "2:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatSeconds(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 100) / 10} s`;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? flat.slice(0, 300) + "..." : flat;
}

export class SttClient {
  readonly baseUrl: string;
  readonly model: string;
  private language: string | undefined;
  private timeoutMs: number;
  private healthTimeoutMs: number;

  constructor(opts: SttClientOptions = {}) {
    this.baseUrl = (opts.baseUrl || DEFAULT_STT_URL).replace(/\/+$/, "");
    this.model = opts.model || DEFAULT_STT_MODEL;
    this.language = opts.language || undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  /** null when speaches answers /health with a 2xx, else why not. One
   *  try: Milton is waiting on the answer. */
  async checkHealth(): Promise<string | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.healthTimeoutMs) });
    } catch (e) {
      const err = e as Error;
      const why = err.name === "TimeoutError" ? `no answer within ${formatSeconds(this.healthTimeoutMs)}` : err.message;
      return `Speech to text isn't reachable at ${this.baseUrl} (${why}). Is the speaches container running?`;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) return `Speech to text health check at ${this.baseUrl}/health returned HTTP ${res.status}: ${snippet(text) || "no body"}`;
    return null;
  }

  /** The text of one voice note. Throws SttError. */
  async transcribe(audio: Blob, filename = "voice-note"): Promise<Transcript> {
    if (audio.size === 0) throw new SttError("The voice note is empty.", 400);
    if (audio.size > MAX_VOICE_BYTES) throw new SttError(`The voice note is ${(audio.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB.`, 413);
    if (!isAudioType(audio.type)) throw new SttError(`That file is ${audio.type.split(";")[0]}, not audio.`, 415);

    const health = await this.checkHealth();
    if (health) throw new SttError(health, 503);

    const form = new FormData();
    form.append("file", audio, noteFileName(filename, audio.type));
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    if (this.language) form.append("language", this.language);

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let body: string;
    let res: Response;
    try {
      // Bun's fetch has its own 300 s limit; ours is timeoutMs.
      res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, { method: "POST", body: form, signal: controller.signal, timeout: false });
      body = await res.text();
    } catch (e) {
      if (controller.signal.aborted) throw new SttError(`Speech to text at ${this.baseUrl} timed out after ${formatSeconds(this.timeoutMs)}.`, 504);
      throw new SttError(`Speech to text at ${this.baseUrl} failed mid-request: ${(e as Error).message}`, 502);
    } finally {
      clearTimeout(timer);
    }
    const transcribeSeconds = Math.round((performance.now() - started) / 100) / 10;

    if (res.status === 404 && /model/i.test(body)) {
      throw new SttError(
        `Speech to text at ${this.baseUrl} doesn't have model ${this.model}: ${snippet(body)}. Download it with: curl -X POST ${this.baseUrl}/v1/models/${this.model}`,
        502,
      );
    }
    if (!res.ok) throw new SttError(`Speech to text at ${this.baseUrl} returned HTTP ${res.status}: ${snippet(body) || "no body"}`, 502);

    let parsed: { text?: unknown; duration?: unknown; language?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new SttError(`Speech to text at ${this.baseUrl} answered with something that isn't JSON: ${snippet(body) || "nothing"}`, 502);
    }
    if (!parsed || typeof parsed.text !== "string") {
      throw new SttError(`Speech to text at ${this.baseUrl} answered without a text field: ${snippet(body)}`, 502);
    }

    const durationSeconds = typeof parsed.duration === "number" && Number.isFinite(parsed.duration) ? parsed.duration : undefined;
    // Only known once speaches has read the whole note: the browser checks
    // first, this is the server's own word on it.
    if (durationSeconds !== undefined && durationSeconds > MAX_VOICE_SECONDS + DURATION_SLACK_SECONDS) {
      throw new SttError(`The voice note is ${clock(durationSeconds)} long; the limit is ${clock(MAX_VOICE_SECONDS)}.`, 413);
    }
    const text = parsed.text.replace(/\s+/g, " ").trim();
    if (!text) throw new SttError("No speech was heard in the voice note.", 422);

    return {
      text,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(typeof parsed.language === "string" ? { language: parsed.language } : {}),
      model: this.model,
      transcribeSeconds,
    };
  }
}

/** Reads a request body, refusing more than `limit` bytes as soon as it
 *  is passed, so a chunked upload with no Content-Length can't fill
 *  memory. null when it is too big. */
export async function readCapped(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Room for the multipart boundaries and headers around the file. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * `POST /voice`: a multipart body with the note in `file`, read with the
 * 10 MB cap, transcribed. Resolves to the transcript or throws SttError.
 */
export async function transcribeVoiceRequest(req: Request, stt: SttClient): Promise<Transcript> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(type)) throw new SttError("Send the voice note as multipart/form-data with the audio in a field named file.", 400);
  const bytes = await readCapped(req, MAX_VOICE_BYTES + MULTIPART_OVERHEAD_BYTES);
  if (!bytes) throw new SttError("The voice note is over the 10 MB limit.", 413);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": type } }).formData();
  } catch {
    throw new SttError("The upload isn't valid multipart/form-data.", 400);
  }
  const file = form.get("file");
  if (!file || typeof file === "string") throw new SttError("No voice note: put the audio in a field named file.", 400);
  return stt.transcribe(file, (file as File).name || "voice-note");
}

import { join } from "node:path";
import { audioFilePath, isSafeRunId, type SpeakResult } from "../executors/tts.ts";
import { pipelineAudioBytes, pipelineAudioResponse } from "./pipeline-audio.ts";
import type { ChatMessage } from "./conversations.ts";

/**
 * Ask's spoken replies (docs/SDD-wissel-app.md §3.5): "Play reply" on a
 * concierge message has Kokoro speak it, through the same per-URL queue
 * as the podcasts (TtsExecutor.speak), and keeps the MP3 per message at
 * `<audioDir>/ask/<messageId>.mp3`, so the second play is instant and
 * Kokoro speaks each reply once. A message never changes after it is
 * stored, so the cache never goes stale.
 */

/** The longest reply Kokoro is asked to read; the rest stays in the chat. */
export const MAX_SPOKEN_CHARS = 4000;
/** A reply waits at most this long behind other audio (a podcast takes
 *  4 to 5 minutes) before answering "busy". */
export const REPLY_QUEUE_WAIT_MS = 60_000;

export function replyAudioDir(audioDir: string): string {
  return join(audioDir, "ask");
}

export function replyAudioUrl(messageId: string): string {
  return `/ask/${encodeURIComponent(messageId)}/audio`;
}

/**
 * A reply as it should sound: no Markdown marks, no code, links named
 * rather than spelled out, one line. Cut at a sentence end before
 * MAX_SPOKEN_CHARS when it is longer. "" when nothing is left to say.
 */
export function spokenText(text: string, max = MAX_SPOKEN_CHARS): string {
  let t = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  t = end > max / 2 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max);
  return `${t} The rest is in the chat.`;
}

export class ReplyAudioError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 500 | 502 | 503 | 504,
  ) {
    super(message);
  }
}

export interface ReplyAudio {
  audioUrl: string;
  bytes: number;
  /** True when the MP3 was already on disk. */
  cached: boolean;
}

export interface ReplyAudioDeps {
  audioDir: string;
  message(id: string): ChatMessage | undefined;
  /** TtsExecutor.speak, bound to the server's Kokoro. */
  speak(text: string, file: string, opts: { maxQueueWaitMs?: number }): Promise<SpeakResult>;
  queueWaitMs?: number;
}

const STATUS: Record<Exclude<SpeakResult, { ok: true }>["kind"], ReplyAudioError["status"]> = {
  unavailable: 503,
  busy: 503,
  timeout: 504,
  "bad-response": 502,
  save: 500,
};

export function createReplyAudio(deps: ReplyAudioDeps) {
  const dir = replyAudioDir(deps.audioDir);
  /** One synthesis per message at a time: a second tap, or a second tab,
   *  waits on the first instead of queueing the same reply again. */
  const inFlight = new Map<string, Promise<ReplyAudio>>();

  async function make(messageId: string): Promise<ReplyAudio> {
    const message = deps.message(messageId);
    if (!message) throw new ReplyAudioError(`message not found: ${messageId}`, 404);
    if (message.role !== "assistant") throw new ReplyAudioError("Only wissel's replies can be played.", 400);

    const cachedBytes = await pipelineAudioBytes(dir, messageId);
    if (cachedBytes !== null) return { audioUrl: replyAudioUrl(messageId), bytes: cachedBytes, cached: true };

    const text = spokenText(message.text);
    if (!text) throw new ReplyAudioError("This reply has nothing to read out.", 400);
    const spoken = await deps.speak(text, audioFilePath(dir, messageId), { maxQueueWaitMs: deps.queueWaitMs ?? REPLY_QUEUE_WAIT_MS });
    if (!spoken.ok) throw new ReplyAudioError(spoken.reason, STATUS[spoken.kind]);
    console.log(`ask: reply ${messageId} spoken, ${text.length} chars -> ${spoken.bytes} bytes in ${spoken.synthesisSeconds}s`);
    return { audioUrl: replyAudioUrl(messageId), bytes: spoken.bytes, cached: false };
  }

  return {
    /** `POST /ask/:messageId/audio`. Throws ReplyAudioError. */
    ensure(messageId: string): Promise<ReplyAudio> {
      // Message ids are UUIDs; this keeps anything else off the disk path.
      if (!isSafeRunId(messageId)) return Promise.reject(new ReplyAudioError(`message not found: ${messageId}`, 404));
      const running = inFlight.get(messageId);
      if (running) return running;
      const p = make(messageId).finally(() => inFlight.delete(messageId));
      inFlight.set(messageId, p);
      return p;
    },

    /** `GET`/`HEAD /ask/:messageId/audio`: the cached MP3, with Range. */
    response(messageId: string, req: Request): Promise<Response> {
      if (!isSafeRunId(messageId)) return Promise.resolve(new Response("no audio for this message", { status: 404 }));
      return pipelineAudioResponse(dir, messageId, req);
    },
  };
}

export type ReplyAudioService = ReturnType<typeof createReplyAudio>;

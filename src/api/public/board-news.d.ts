// Type declaration for board-news.js: a plain browser script (no build
// step, see its own header comment) that's also imported directly by
// bun test. Kept in sync by hand; the .js file is the source of truth
// for behavior.

export const NEWS_FLAG_NOT_FROM_GATHER: string;
export const NEWS_FLAG_UNCHECKED: string;
export const NEWS_FLAG_NOT_A_LINK: string;
export const NEWS_FLAG_MISSING: string;

export function parseHandoffData(text: unknown): Record<string, unknown> | null;
export function gatherUrlSet(gatherData: unknown): Set<string> | null;
export function splitScript(script: unknown): string[];

export interface NewsRow {
  headline: string;
  oneLine: string;
  /** As handed off, trimmed; "" when missing. */
  source: string;
  /** `source` when it is an http(s) URL, else null (never linked). */
  href: string | null;
  /** Why this row's source can't be trusted, or null. */
  flag: string | null;
}

export type NewsView =
  | { kind: "none" }
  | { kind: "raw"; reason: string; raw: string }
  | { kind: "news"; rows: NewsRow[]; paragraphs: string[]; wordCount: number; flaggedCount: number; gatherChecked: boolean };

export function newsView(finalSummary: unknown, gatherSummary: unknown, expected: boolean): NewsView;

export const NEWS_SCRIPT_AGENT: string;
export const NEWS_AUDIO_AGENT: string;

export interface NewsStepCard {
  id: string;
  status: string;
  pipelineStepId?: string;
  routedTo?: string;
}

export function newsStepCards<C extends NewsStepCard>(
  steps: C[] | null | undefined,
  defSteps: { id: string; agentId: string }[] | null | undefined,
): { news: C; expected: boolean; gather: C | null; audio: C | null } | null;

export type NewsAudioView =
  | { state: "ready"; url: string; bytes: number | null }
  | { state: "making" }
  | { state: "failed" }
  | { state: "none" };

export function newsAudioView(audioCard: { status: string } | null | undefined, summaryAudio: unknown): NewsAudioView;

export interface SpeechLike {
  speak(u: unknown): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  paused?: boolean;
  speaking?: boolean;
  pending?: boolean;
  getVoices?(): VoiceLike[];
}

export interface VoiceLike {
  lang: string;
  name?: string;
  default?: boolean;
  localService?: boolean;
}

export function hasSpeech(win: unknown): boolean;
export function pickVoice<V extends VoiceLike>(voices: V[] | null | undefined): V | null;

export type NewsReaderState = "idle" | "speaking" | "paused";

export interface NewsReader {
  state(): NewsReaderState;
  current(): number;
  play(paragraphs: string[]): void;
  pause(): void;
  stop(): void;
}

export function createNewsReader(
  synth: SpeechLike,
  Utterance: new (text: string) => object,
  onChange?: (state: NewsReaderState, index: number) => void,
): NewsReader;

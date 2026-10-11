import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { postVoice } from "./api";
import { canRecordInPage, createRecorder, pickRecorderType, voiceFileProblem, type Recorder } from "./voice";

// React glue for Ask's voice notes (docs/SDD-wissel-app.md §3.5): the
// mic button records in the page where it can, else opens the phone's
// recorder through a file input; either way the note goes to POST /voice
// and its text comes back to the Ask box.

export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

export interface VoiceNote {
  /** "record" where the page can record, else "file". */
  mode: "record" | "file";
  phase: VoicePhase;
  /** Seconds recorded so far, while recording. */
  elapsed: number;
  error: string | null;
  /** The mic button: starts a recording, or opens the file picker. */
  press: () => void;
  stop: () => void;
  cancel: () => void;
  fileInput: React.RefObject<HTMLInputElement>;
  onFile: (e: ChangeEvent<HTMLInputElement>) => void;
}

/** The length the browser reads from a picked file, or undefined (a
 *  recorder's WebM often has none). Gives up after 3 s. */
function durationOf(file: Blob): Promise<number | undefined> {
  return new Promise((resolve) => {
    let url = "";
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(undefined);
      return;
    }
    const el = document.createElement("audio");
    const done = (d: number | undefined) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      resolve(d !== undefined && Number.isFinite(d) && d > 0 ? d : undefined);
    };
    const timer = setTimeout(() => done(undefined), 3000);
    el.preload = "metadata";
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(undefined);
    el.src = url;
  });
}

export function useVoiceNote(onText: (text: string) => void): VoiceNote {
  const [mode] = useState<"record" | "file">(() =>
    canRecordInPage({ mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : undefined, MediaRecorder: typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined })
      ? "record"
      : "file",
  );
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textRef = useRef(onText);
  textRef.current = onText;
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
      recorder.current?.cancel();
    },
    [],
  );

  const send = useCallback(async (note: Blob, name: string) => {
    setPhase("transcribing");
    setError(null);
    try {
      const { text } = await postVoice(note, name);
      if (alive.current) textRef.current(text);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setPhase("idle");
    }
  }, []);

  // The clock while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => setElapsed(recorder.current?.elapsed() ?? 0), 250);
    return () => clearInterval(id);
  }, [phase]);

  const press = useCallback(() => {
    if (phase !== "idle") return;
    setError(null);
    if (mode === "file") {
      fileInput.current?.click();
      return;
    }
    const mimeType = pickRecorderType(typeof MediaRecorder.isTypeSupported === "function" ? (t) => MediaRecorder.isTypeSupported(t) : undefined);
    const r = createRecorder({
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createRecorder: (stream, type) => new MediaRecorder(stream as MediaStream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 }),
      mimeType,
    });
    recorder.current = r;
    r.onCapped((rec) => {
      recorder.current = null;
      void send(rec.blob, rec.name);
    });
    setPhase("starting");
    setElapsed(0);
    r.start().then(
      () => alive.current && setPhase("recording"),
      (err: unknown) => {
        // Cancelled before the mic answered: nothing to report.
        if (recorder.current !== r) return;
        recorder.current = null;
        if (!alive.current) return;
        setPhase("idle");
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [phase, mode, send]);

  const stop = useCallback(() => {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    r.stop().then(
      (rec) => {
        if (rec.blob.size === 0) {
          setPhase("idle");
          setError("Nothing was recorded.");
          return;
        }
        void send(rec.blob, rec.name);
      },
      () => setPhase("idle"),
    );
  }, [send]);

  const cancel = useCallback(() => {
    recorder.current?.cancel();
    recorder.current = null;
    setPhase("idle");
  }, []);

  const onFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const file = input.files?.[0];
      // Cleared so picking the same file again still fires.
      input.value = "";
      if (!file) return;
      const problem = voiceFileProblem(file, await durationOf(file));
      if (problem) {
        setError(problem);
        return;
      }
      void send(file, file.name || "voice-note");
    },
    [send],
  );

  return { mode, phase, elapsed, error, press, stop, cancel, fileInput, onFile };
}

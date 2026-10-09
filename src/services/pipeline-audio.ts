import { stat } from "node:fs/promises";
import { audioFilePath } from "../executors/tts.ts";

/**
 * A pipeline run's MP3 (written by TtsExecutor, src/executors/tts.ts),
 * read side: whether it exists for the run summary, and the HTTP
 * response for `GET /pipeline-runs/:id/audio` (src/api/server.ts),
 * docs/SDD-ai-news-podcast.md §3.7. The caller has already checked the
 * id is a run root on the board; the path comes from audioFilePath, the
 * same function the executor writes with.
 */

/** Size in bytes of the run's MP3, or null when there is none. */
export async function pipelineAudioBytes(audioDir: string, runId: string): Promise<number | null> {
  try {
    const s = await stat(audioFilePath(audioDir, runId));
    return s.isFile() && s.size > 0 ? s.size : null;
  } catch {
    return null;
  }
}

/** One byte range from a Range header against a file of `size` bytes:
 *  the inclusive [start, end] to send, "unsatisfiable" for a range past
 *  the end (416), or null to ignore the header and send the whole file
 *  (no header, a malformed one, or several ranges, which RFC 9110 lets
 *  a server answer with a plain 200). Phones seek MP3s with
 *  `bytes=N-` and Safari probes with `bytes=0-1`. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== "" && Number(m[2]) < start) return null;
  }
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/** 200 with the whole MP3, 206 with one range, 416 for a range past the
 *  end, 404 when the run has no audio. HEAD gets the same headers and no
 *  body. */
export async function pipelineAudioResponse(audioDir: string, runId: string, req: Request): Promise<Response> {
  const size = await pipelineAudioBytes(audioDir, runId);
  if (size === null) return new Response("no audio for this run", { status: 404 });
  const file = Bun.file(audioFilePath(audioDir, runId));
  const headers: Record<string, string> = {
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "content-disposition": `inline; filename="${runId}.mp3"`,
  };
  const head = req.method === "HEAD";
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }
  if (range === null) {
    return new Response(head ? null : file, { status: 200, headers: { ...headers, "content-length": String(size) } });
  }
  return new Response(head ? null : file.slice(range.start, range.end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) },
  });
}

#!/usr/bin/env bun
/**
 * Makes eval:stt's five fixture notes (eval/fixtures/stt/, docs/SDD-wissel-app.md
 * §4.4) by having the local Kokoro read each note's text from
 * notes.json as Opus. A synthetic voice is the stand-in until Milton
 * records his own (eval/fixtures/stt/README.md): same names, same text.
 *
 *   bun run scripts/make-stt-fixtures.ts            # skip notes already there
 *   bun run scripts/make-stt-fixtures.ts --force    # remake all five
 *
 * Kokoro at WISSEL_TTS_URL (default http://127.0.0.1:8880), voice
 * WISSEL_TTS_VOICE (default af_heart). Every note must stay under 256 KB;
 * a bigger one is not written and the script says how to shrink it.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_TTS_URL, DEFAULT_TTS_VOICE } from "../src/executors/tts.ts";
import { MAX_FIXTURE_BYTES } from "../eval/stt-checks.ts";
import { FIXTURE_DIR, loadNotes } from "../eval/stt.eval.ts";

const force = process.argv.includes("--force");
const url = (process.env.WISSEL_TTS_URL || DEFAULT_TTS_URL).replace(/\/+$/, "");
const voice = process.env.WISSEL_TTS_VOICE || DEFAULT_TTS_VOICE;

let failed = 0;
for (const note of loadNotes()) {
  const path = join(FIXTURE_DIR, note.file);
  if (existsSync(path) && !force) {
    console.log(`skip  ${note.file} (already there; --force to remake)`);
    continue;
  }
  const res = await fetch(`${url}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "kokoro", voice, input: note.text, response_format: "opus" }),
  }).catch((e: Error) => e);
  if (res instanceof Error) {
    console.error(`Kokoro isn't reachable at ${url} (${res.message}). Is the kokoro-tts container running?`);
    process.exit(2);
  }
  if (!res.ok || !/^audio\//i.test(res.headers.get("content-type") ?? "")) {
    console.error(`fail  ${note.file}: Kokoro answered HTTP ${res.status} ${res.headers.get("content-type")}: ${(await res.text()).slice(0, 200)}`);
    failed++;
    continue;
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength >= MAX_FIXTURE_BYTES) {
    console.error(
      `fail  ${note.file}: ${audio.byteLength} bytes, over the ${MAX_FIXTURE_BYTES} limit. Re-encode smaller, e.g. ffmpeg -i in.opus -c:a libopus -b:a 24k -ac 1 ${path}`,
    );
    failed++;
    continue;
  }
  await writeFile(path, audio);
  console.log(`made  ${note.file} (${audio.byteLength} bytes): ${note.text}`);
}
process.exit(failed ? 1 : 0);

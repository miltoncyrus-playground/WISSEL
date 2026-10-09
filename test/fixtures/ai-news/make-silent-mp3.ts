#!/usr/bin/env bun
/**
 * Writes test/fixtures/ai-news/silence.mp3: 1.5 s of silence as plain
 * MPEG-1 Layer III frames (44.1 kHz, mono, 32 kbps, no ID3 tag). The
 * fake Kokoro server in the tests returns it, and the e2e plays it, so it
 * has to be a file a browser actually decodes, not random bytes.
 * test/tts-executor.test.ts checks the checked-in file still equals
 * silentMp3(), so it can always be regenerated:
 *
 *   bun test/fixtures/ai-news/make-silent-mp3.ts
 *
 * Each frame is a 4-byte header, a 17-byte all-zero side info (mono, so
 * part2_3_length is 0 for both granules: no Huffman data, every sample
 * decodes to 0) and zero padding up to the frame length,
 * 144 * 32000 / 44100 = 104 bytes (padding bit 0). 1152 samples per
 * frame, so 58 frames are 66816 samples, about 1.52 s.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const SILENT_MP3_FRAMES = 58;
export const SILENT_MP3_FRAME_BYTES = 104;
/** sync + MPEG-1 + Layer III + no CRC, 32 kbps / 44.1 kHz / no padding,
 *  mono / original. */
const HEADER = [0xff, 0xfb, 0x10, 0xc4];

export function silentMp3(frames = SILENT_MP3_FRAMES): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(frames * SILENT_MP3_FRAME_BYTES);
  for (let i = 0; i < frames; i++) out.set(HEADER, i * SILENT_MP3_FRAME_BYTES);
  return out;
}

export const SILENT_MP3_PATH = join(import.meta.dir, "silence.mp3");

if (import.meta.main) {
  writeFileSync(SILENT_MP3_PATH, silentMp3());
  console.log(`wrote ${SILENT_MP3_PATH} (${SILENT_MP3_FRAMES * SILENT_MP3_FRAME_BYTES} bytes)`);
}

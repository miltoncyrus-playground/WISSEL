#!/usr/bin/env bun
// The e2e server's speech to text (playwright.config.ts points
// WISSEL_STT_URL here): test/fixtures/fake-speaches.ts on a fixed port.
// Every note is heard as "Create a card to check the README."; a spec can
// change that, or switch to a failure, with POST /fake/mode, and read the
// last upload with GET /fake/last.
import { startFakeSpeaches } from "../../test/fixtures/fake-speaches.ts";

const port = Number(process.env.FAKE_STT_PORT ?? 8791);
startFakeSpeaches({ port });
console.log(`fake speaches on :${port}`);

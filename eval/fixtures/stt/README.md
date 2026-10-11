# eval:stt fixture notes

Five short voice notes for `bun run eval:stt` (docs/SDD-wissel-app.md
§4.4). `notes.json` lists each note's file and exactly what it says; the
eval sends every file through `POST /voice` and passes when the word
error rate over all five is 15% or less.

Rules: Opus audio (`.opus`, Ogg or WebM container), each file under
256 KB, the words in `notes.json` and nothing else. `test/stt-eval.test.ts`
checks the list and the sizes on every `bun run test`.

The `.opus` files are not committed (no binaries in the repo;
`.gitignore` keeps them out). `bun run eval:stt` makes any missing one
from Kokoro before it runs. A note you recorded yourself stays put.

## Making them

With Kokoro running (synthetic voice, quick):

    bun run scripts/make-stt-fixtures.ts

Better, your own voice on your phone, since that is what the app will
hear. Read each sentence, then shrink to mono Opus at 24 kbit/s:

    ffmpeg -i readme-card.m4a -c:a libopus -b:a 24k -ac 1 eval/fixtures/stt/readme-card.opus

A 6 second note at 24 kbit/s is about 18 KB.

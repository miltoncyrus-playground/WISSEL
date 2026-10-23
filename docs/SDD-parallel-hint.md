# SDD — A prompt hint to work in fewer turns (`WISSEL_PARALLEL_HINT`)

Status: **Built, off by default.** `PARALLEL_HINT`, `parallelHintOn`, the
`parallelHint` prompt option, wired in `runClaude`. `test/parallel-hint.test.ts`.

## 1. The problem

Measured on the saved output of 58 runs: reviews average 3.0 minutes and
implementers 7.9, the slowest 10 to 16 minutes at $5 to $9. About half of that
is waits over 20 s (the model thinking or writing). Implementers make 53 to 78
`Read` calls and up to 40 `Bash` calls, one per turn, and almost no run fans
read-only work out to sub-agents. Each call is a model round trip.

## 2. Design

`WISSEL_PARALLEL_HINT=1` (or `true`, `on`) appends one paragraph to the prompt
of every claude-cli run: issue independent reads, greps and checks in one turn;
start independent read-only sub-agents together; keep every write, edit and the
final answer to itself; never skip a check to save time. Off or unset the prompt
is byte-identical to before. Only the claude-cli harness gets it (codex has no
Agent tool). Resumed runs keep their own resume prompt.

## 3. How to judge it

Run a batch with it on, compare average wall time and `Read`/`Bash` counts per
role against the 7.9 and 3.0 minute baselines above (the sub-agent chips on the
board show whether fan-out happened). Turn it off again if review findings get
thinner: the hint asks for fewer turns, not less checking.

## 4. Not here

No model change, no change to tool permissions, no per-role hint.

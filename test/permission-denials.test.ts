import { expect, test } from "bun:test";
import { commandKeys, splitShell, summarizeDenials } from "../src/core/permission-denials.ts";

// Quote-aware command splitting (src/core/permission-denials.ts). The
// old split on `|`, `&&`, `;` cut inside quotes and produced junk keys
// like "Bash: mergedSha\\" (card 494f87d6, 2026-10-17).

/** The 16 Bash refusals of card 494f87d6 (2026-10-17), one per evidence
 *  line of the card that specified this fix: read-only shell not on the
 *  allowlist, allowed commands inside compounds, shell edits, and
 *  arbitrary code. Rebuilt from that evidence, because this run could
 *  not read ~/.wissel/task-output/; `bun run denials:baseline --fixtures
 *  494f87d6-cd76-4348-ad22-8785c066c49c` prints the verbatim ones with
 *  their keys to check against this table. */
const CARD_494F87D6: [command: string, keys: string[]][] = [
  // Read-only shell.
  ['grep -rn "mergedSha\\|landedSha" src test', []],
  ['grep -rn "recordMerge(\\|mergedAt" src/services/board.ts', []],
  ["sed -n '220,330p' src/services/worktree.ts", ["sed"]],
  ["sed -n '1,60p' test/merge-path.test.ts", ["sed"]],
  ["cat src/services/repo-lock.ts", []],
  ["ls src/services", []],
  ["git --version", ["git"]],
  ["bun --version", ["bun"]],
  // Allowed commands inside compounds: every segment must match a rule.
  ['bun test test/merge-path.test.ts 2>&1 | grep -E "(pass|fail)"', ["bun test"]],
  ["bun test test/ 2>&1 | tail -30", ["bun test"]],
  ["time bun run typecheck", ["bun run typecheck"]],
  ["bun test > /tmp/merge-test.log 2>&1", ["bun test"]],
  // Shell edits (should be the Edit tool).
  ["sed -i 's/lockWaitMs|lockHoldMs/lockMs/' src/services/worktree.ts", ["sed"]],
  ['sed -i "s/\\"landed\\" | \\"conflict\\"/\\"landed\\"/" src/services/telemetry.ts', ["sed"]],
  // Arbitrary code (correctly denied).
  ["bun -e 'import { mergeTaskWorktree } from \"./src/services/worktree.ts\"; console.log(typeof mergeTaskWorktree)'", ["bun -e"]],
  // The one in the card's own text.
  ['grep -rn "a(\\|b(" src', []],
];

test("card 494f87d6's 16 refusals get the expected keys", () => {
  expect(CARD_494F87D6).toHaveLength(16);
  for (const [command, keys] of CARD_494F87D6) expect({ command, keys: commandKeys(command) }).toEqual({ command, keys });
});

test("card 494f87d6 summarized: nine clean keys, no junk from inside quotes", () => {
  const raw = CARD_494F87D6.map(([command]) => ({ tool_name: "Bash", tool_input: { command } }));
  const keys = summarizeDenials(raw);
  expect(keys).toEqual(["Bash: grep (shell form)", "Bash: sed", "Bash: cat (shell form)", "Bash: ls (shell form)", "Bash: git", "Bash: bun", "Bash: bun test", "Bash: bun run typecheck", "Bash: bun -e"]);
  for (const k of keys) expect(k.replace(" (shell form)", "")).not.toMatch(/["'\\()]/);
});

test("quoted pipes, semicolons and ampersands don't split", () => {
  expect(splitShell(`grep -E "a|b;c&&d" src`)).toEqual([["grep", "-E", "a|b;c&&d", "src"]]);
  expect(splitShell(`echo 'x | y' | wc -l`)).toEqual([["echo", "x | y"], ["wc", "-l"]]);
  expect(splitShell(`printf a\\|b`)).toEqual([["printf", "a|b"]]);
  expect(commandKeys(`npm run build -- --filter "a|b" && npm test`)).toEqual(["npm run build", "npm test"]);
});

test("double quotes keep backslashes except before \" \\ $ and backtick", () => {
  expect(splitShell(`grep "a\\|b" x`)).toEqual([["grep", "a\\|b", "x"]]);
  expect(splitShell(`echo "say \\"hi\\" \\$HOME"`)).toEqual([["echo", 'say "hi" $HOME']]);
  expect(splitShell(`echo 'single \\n stays'`)).toEqual([["echo", "single \\n stays"]]);
  expect(splitShell(`echo "ab"'cd'ef`)).toEqual([["echo", "abcdef"]]);
});

test("every separator ends a command; redirects and their targets are dropped", () => {
  expect(splitShell("a; b && c || d | e & f\ng")).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"]]);
  expect(splitShell("bun test 2>&1")).toEqual([["bun", "test"]]);
  expect(splitShell("bun test >/tmp/x 2>/dev/null")).toEqual([["bun", "test"]]);
  expect(splitShell("bun test &> out.log")).toEqual([["bun", "test"]]);
  expect(splitShell("bun test >> out.log; ls")).toEqual([["bun", "test"], ["ls"]]);
  expect(splitShell("wc -l < file.txt")).toEqual([["wc", "-l"]]);
  expect(splitShell("bun test 2>&-")).toEqual([["bun", "test"]]);
  // A trailing redirect with no target doesn't eat the next command.
  expect(splitShell("a > ; b")).toEqual([["a"], ["b"]]);
  // "10" not directly before the operator is a real argument.
  expect(splitShell("head -n 10 > x")).toEqual([["head", "-n", "10"]]);
  expect(splitShell('echo "2" > x')).toEqual([["echo", "2"]]);
});

test("subshells split; $(...) and backticks stay in their word", () => {
  expect(splitShell("(cd app && bun test)")).toEqual([["cd", "app"], ["bun", "test"]]);
  expect(splitShell("echo $(git rev-parse HEAD | cut -c1-7) done")).toEqual([["echo", "$(git rev-parse HEAD | cut -c1-7)", "done"]]);
  expect(splitShell("echo `date | tr a b`")).toEqual([["echo", "`date | tr a b`"]]);
});

test("unterminated quotes don't throw", () => {
  expect(splitShell(`grep "abc`)).toEqual([["grep", "abc"]]);
  expect(splitShell(`grep 'abc`)).toEqual([["grep", "abc"]]);
  expect(splitShell(`echo $(oops`)).toEqual([["echo", "$(oops"]]);
  expect(splitShell("")).toEqual([]);
});

// Card 7821db37 (2026-10-17, attempt 1): the first quote-aware split
// treated every newline as a separator, so heredoc bodies and shell
// keywords became keys ("Bash: const m", "Bash: if", "Bash: do sed",
// "Bash: } return", "Bash: //"). Its refused list is the junk below.
const CARD_7821DB37: [command: string, keys: string[]][] = [
  // The reviewer's four repros.
  ["cat > f <<'EOF'\nconst m = 1;\nif (m) return;\n// hi\nEOF", []],
  ["python3 - <<'PY'\nimport os\nPY", ["python3"]],
  ["for f in a b; do sed -n 1p $f; done", ["sed"]],
  ["if bun run typecheck; then bun test; fi", ["bun run typecheck", "bun test"]],
  // Multi-line shapes from the same run's refused list.
  [
    "cat > /tmp/probe.ts <<'EOF'\nconst words = cmd.split(' ');\nconst program = words[0];\n/**\n * doc\n */\nexport function f(sub: string) {\n  if (!REFUSED_SUBCOMMANDS[program]?.has(sub)) return undefined;\n  try { x(); } catch { }\n  return undefined;\n}\nEOF\nbun /tmp/probe.ts",
    ["bun"],
  ],
  ['python3 - <<"PY"\nimport json\nfor line in open("x"):\n    print(line)\nPY\necho done', ["python3"]],
  ["cat <<-EOF > out.txt\n\tconst targets = new Set();\n\tEOF\nsed -n '1,5p' out.txt", ["sed"]],
  ["which bwrap socat; sysctl kernel.apparmor_restrict_unprivileged_userns", ["which bwrap", "sysctl kernel.apparmor_restrict_unprivileged_userns"]],
  ["while read f; do\n  git diff --stat \"$f\"\ndone < files.txt", ["read f", "git diff"]],
  ["case \"$1\" in\n  a|b) bun test ;;\n  *.ts) bun run typecheck ;;\n  *) echo no ;;\nesac", ["bun test", "bun run typecheck"]],
  ["case $x in a) git status;; esac", ["git status"]],
  ["{ bun test; bun run typecheck; } 2>&1 | tail -5", ["bun test", "bun run typecheck"]],
  ["! git diff --quiet && echo dirty", ["git diff"]],
  ["$CMD --flag && find . -name '*.ts'", ["find"]],
];

test("card 7821db37: heredoc bodies and shell keywords never become keys", () => {
  for (const [command, keys] of CARD_7821DB37) expect({ command, keys: commandKeys(command) }).toEqual({ command, keys });
});

test("card 7821db37 summarized: none of the junk keys from its refused list", () => {
  const raw = CARD_7821DB37.map(([command]) => ({ tool_name: "Bash", tool_input: { command } }));
  const keys = summarizeDenials(raw);
  const junk = ["const m", "if", "for", "do sed", "done", "fi", "then bun", "import os", "PY", "EOF", "//", "/**", "} return", "const words", "const program", "try", "} catch", "*.ts", "a", "b"];
  for (const j of junk) expect(keys).not.toContain(`Bash: ${j}`);
  for (const k of keys) expect(k).not.toMatch(/[{}();]|^Bash: (const|import|return|export)\b/);
});

test("heredocs: quoted, unquoted, <<- and several on one line are skipped", () => {
  expect(splitShell("cat <<EOF\nx | y\nEOF\nls")).toEqual([["cat"], ["ls"]]);
  expect(splitShell('cat <<"END" > f\na; b\nEND')).toEqual([["cat"]]);
  expect(splitShell("cat <<\\EOF\n$x\nEOF")).toEqual([["cat"]]);
  expect(splitShell("cat <<-EOF\n\tbody\n\tEOF\nls")).toEqual([["cat"], ["ls"]]);
  // Without "-", a tab-indented delimiter doesn't close the body.
  expect(splitShell("cat <<EOF\n\tEOF\nstill body\nEOF\nls")).toEqual([["cat"], ["ls"]]);
  expect(splitShell("paste <<A <<B\n1\nA\n2\nB\nwc")).toEqual([["paste"], ["wc"]]);
  // A delimiter that is only a prefix of the line doesn't close it.
  expect(splitShell("cat <<EOF\nEOFX\nEOF\nls")).toEqual([["cat"], ["ls"]]);
  // Unterminated body: everything after is body, nothing throws.
  expect(splitShell("cat <<EOF\nrm -rf x")).toEqual([["cat"]]);
  // Here-strings are not heredocs; "<<" inside quotes is not either.
  expect(splitShell("grep x <<< \"$y\"\nls")).toEqual([["grep", "x"], ["ls"]]);
  expect(splitShell("echo '<<EOF'\nls")).toEqual([["echo", "<<EOF"], ["ls"]]);
});

test("shell keywords: dropped at command start, headers skipped, not inside args", () => {
  expect(commandKeys("until git fetch; do sleep 1; done")).toEqual(["git fetch", "sleep"]);
  expect(commandKeys("if [ -f x ]; then git add x; elif true; then :; else npm test; fi")).toEqual(["git add", "npm test"]);
  expect(commandKeys("for i in 1 2 3\ndo\n  bun test\ndone")).toEqual(["bun test"]);
  expect(commandKeys("FOO=1 time do bun test")).toEqual(["bun test"]);
  // A keyword as an argument is just an argument.
  expect(commandKeys("git log --grep done")).toEqual(["git log"]);
});

test("inline-code interpreters are keyed by -e, whatever the code says", () => {
  expect(commandKeys(`node -e "require('fs')"`)).toEqual(["node -e"]);
  expect(commandKeys(`bun --eval 'x'`)).toEqual(["bun -e"]);
  expect(commandKeys("node script.js")).toEqual(["node script.js"]);
});

test("a heredoc with a helper-only command gets a descriptive key, never a bare Bash", () => {
  const heredoc = "cat >> notes.md <<'EOF'\nmake fast\nEOF";
  expect(commandKeys(heredoc)).toEqual([]);
  expect(summarizeDenials([{ tool_name: "Bash", tool_input: { command: heredoc } }])).toEqual(["Bash: heredoc"]);
});

test("a helper-only command (cat) is keyed by its program in shell form", () => {
  expect(summarizeDenials([{ tool_name: "Bash", tool_input: { command: "cat notes.md" } }])).toEqual(["Bash: cat (shell form)"]);
  expect(summarizeDenials([{ tool_name: "Bash", tool_input: { command: "FOO=1 cat notes.md" } }])).toEqual(["Bash: cat (shell form)"]);
});

/**
 * Turns `claude -p`'s raw `permission_denials` into short, comparable
 * keys ("Bash: bun install"), and decides when a review loop is stuck on
 * a permission rather than on the code.
 *
 * Why: the "Wissel app 1/6" card (2026-10-10) was refused `bun install`
 * on every attempt; the reviewer kept asking for exactly that, and the
 * loop ran 5 rounds ($9.28) before escalating. The same refusal on two
 * consecutive attempts now escalates at once with the refused commands
 * named, so a human grants them (POST /tasks/:id/allowed-tools) instead.
 *
 * Real refusals for one need come in different wordings:
 *   "cd /x/app && ls -la && timeout 300 bun install 2>&1 | tail -20"
 *   "bun install --cwd /x/app"
 *   "npm install --prefix app"
 * so a key is program + subcommand per command segment, skipping
 * navigation and output helpers, not the raw string.
 *
 * Segments are split quote-aware (splitShell). The old split on `|`,
 * `&&`, `;` cut inside quotes, so `grep -rn "a(\|b(" src` became junk
 * keys like "Bash: mergedSha\\" (card 494f87d6, 2026-10-17), which
 * inflated every denial-key count before that date.
 */

/** Package managers whose `run <script>` names the script. */
const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
/** Programs that only navigate or shape output; never the real need. */
const HELPERS = new Set(["cd", "ls", "cat", "echo", "pwd", "tail", "head", "grep", "wc", "sort", "true", "test", "["]);
/** Wrappers whose real command follows their own arguments. */
const WRAPPERS: Record<string, number> = { timeout: 1, nice: 0, time: 0 };
/** Shell keywords that start a command without being one: dropped, and
 *  the command after them is keyed ("then bun test" is bun test). */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "esac", "{", "}", "!", "[[", "]]"]);
/** Keywords whose whole segment is a header ("for f in a b"), not a command. */
const HEADERS = new Set(["for", "select", "case"]);

/** Interpreters whose `-e` runs inline code: keyed "bun -e", never by
 *  whatever the code happens to start with. */
const EVALUATORS = new Set(["bun", "node", "deno"]);
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

/**
 * Splits a shell line into its simple commands, each as its words with
 * quotes removed, the way a POSIX shell would:
 *   - single quotes are literal; double quotes keep `\` before `"`, `\`,
 *     `$` and backtick only; a backslash outside quotes escapes the next
 *     character. `grep -rn "a(\|b(" src` is one command, not two.
 *   - unquoted `|`, `||`, `&&`, `;`, `&`, newlines and `(`/`)` end a
 *     command.
 *   - redirections (`>`, `>>`, `<`, `2>&1`, `&>`, `2>/dev/null`) and
 *     their targets are dropped: `bun test > /tmp/x.log` is `bun test`.
 *   - `$(...)` and backticks stay inside the word they are part of.
 *   - heredoc bodies (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`) are
 *     skipped up to the line that is exactly the delimiter, so the code
 *     in `cat > f <<'EOF'` or `python3 - <<'PY'` is never keyed.
 *   - case patterns (`a|b)`, `;; *)`) are dropped, `|` and all.
 * Shell keywords (if/then/do/for ...) are handled in commandKeys. Not a
 * full shell parser (no function bodies, no arithmetic); good enough to
 * name what a refused command was for.
 *
 * Why hand-written: shell-quote, the usual library, returns operators as
 * objects (`2>&1` is "2", {op:">&"}, "1"), expands `$VAR` against an env,
 * and still needs this much post-processing to drop redirects. This is
 * the post-processing without the dependency.
 */
export function splitShell(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quotedWord = false;
  let skipTarget = false;
  let heredocs: { delim: string; stripTabs: boolean }[] = [];
  let expectPattern = false;
  const endWord = () => {
    if (inWord) {
      if (skipTarget) skipTarget = false;
      else words.push(word);
    }
    word = "";
    inWord = false;
    quotedWord = false;
  };
  const endSegment = () => {
    endWord();
    skipTarget = false;
    if (words.length > 0) segments.push(words);
    words = [];
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i]!;
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? n : close;
      word += command.slice(i + 1, end);
      inWord = true;
      quotedWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < n && '"\\$`'.includes(command[i + 1]!)) {
          word += command[i + 1];
          i += 2;
        } else {
          word += command[i];
          i++;
        }
      }
      inWord = true;
      quotedWord = true;
      i++;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < n && command[i + 1] !== "\n") word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const end = matchParen(command, i + 1);
      word += command.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const close = command.indexOf("`", i + 1);
      const end = close === -1 ? n - 1 : close;
      word += command.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      // Heredoc: remember the delimiter; its body is skipped at the
      // next unquoted newline.
      endWord();
      i += 2;
      const stripTabs = command[i] === "-";
      if (stripTabs) i++;
      while (command[i] === " " || command[i] === "\t") i++;
      let delim = "";
      while (i < n && !" \t\n;|&<>()".includes(command[i]!)) {
        const d = command[i]!;
        if (d === "'" || d === '"') {
          const close = command.indexOf(d, i + 1);
          const end = close === -1 ? n : close;
          delim += command.slice(i + 1, end);
          i = end + 1;
        } else if (d === "\\" && i + 1 < n) {
          delim += command[i + 1];
          i += 2;
        } else {
          delim += d;
          i++;
        }
      }
      if (delim) heredocs.push({ delim, stripTabs });
      continue;
    }
    if (c === "\n" && heredocs.length > 0) {
      endSegment();
      i = skipHeredocs(command, i + 1, heredocs);
      heredocs = [];
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && command[i + 1] === ">")) {
      // A bare fd number right before the operator ("2>") is part of it.
      if (inWord && !quotedWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      while (i < n && "<>&".includes(command[i]!)) {
        if (command[i] === "&" && i > 0 && /[<>]/.test(command[i - 1]!)) {
          // ">&1", ">&-": the target is the fd right here.
          i++;
          while (i < n && /[\d-]/.test(command[i]!)) i++;
          skipTarget = false;
          break;
        }
        i++;
        skipTarget = true;
      }
      continue;
    }
    // Case patterns ("case $x in a|b)", ";; *.ts)") are not commands:
    // their `|` doesn't split, and the pattern is dropped at its `)`.
    const atPattern = expectPattern || words[0] === "case";
    if (atPattern && c === "|") {
      endWord();
      i++;
      continue;
    }
    if (atPattern && c === ")") {
      endWord();
      if (words[0] === "case") endSegment();
      else words = [];
      expectPattern = false;
      i++;
      continue;
    }
    if (c === ";" && command[i + 1] === ";") {
      endSegment();
      expectPattern = true;
      i += 2;
      continue;
    }
    if (c === "|" || c === ";" || c === "&" || c === "\n" || c === "(" || c === ")") {
      if (words[0] === "esac" || (inWord && !quotedWord && words.length === 0 && word === "esac")) expectPattern = false;
      // "case $x in" on its own line: the first pattern is on the next.
      if (words[0] === "case") expectPattern = true;
      endSegment();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endSegment();
  return segments;
}

/** Skips the bodies of `heredocs`, in order, starting at the line that
 *  begins at `start`; returns the index after the last delimiter line
 *  (or the end, for an unterminated body). */
function skipHeredocs(s: string, start: number, heredocs: { delim: string; stripTabs: boolean }[]): number {
  let i = start;
  for (const { delim, stripTabs } of heredocs) {
    while (i < s.length) {
      const nl = s.indexOf("\n", i);
      const lineEnd = nl === -1 ? s.length : nl;
      let line = s.slice(i, lineEnd);
      if (stripTabs) line = line.replace(/^\t+/, "");
      i = lineEnd + 1;
      if (line === delim) break;
    }
  }
  return Math.min(i, s.length);
}

/** Index of the `)` closing the `(` at `open`, or the last index. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return s.length - 1;
}

/** Program + subcommand for each real command in a shell line. */
export function commandKeys(command: string): string[] {
  const keys: string[] = [];
  for (const segment of splitShell(command)) {
    let words = segment;
    // "for f in a b", "case $x in": a loop or case header, no command.
    if (words[0] !== undefined && HEADERS.has(words[0])) continue;
    // Leading keywords ("do sed ..." is sed), VAR=value assignments and
    // wrappers, in any order.
    for (;;) {
      const first = words[0];
      if (first === undefined) break;
      const wrapperArgs = WRAPPERS[first];
      if (KEYWORDS.has(first)) words = words.slice(1);
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words = words.slice(1);
      else if (wrapperArgs !== undefined) words = words.slice(1 + wrapperArgs);
      else break;
    }
    const program = words[0];
    if (!program || HELPERS.has(program)) continue;
    // "$CMD", "*.ts", "//": not a program name, so nothing to key.
    if (!/^[\w.~/+@-][\w.~/+@:-]*$/.test(program) || program.startsWith("//")) continue;
    if (EVALUATORS.has(program) && words.slice(1).some((w) => EVAL_FLAGS.has(w))) {
      const key = `${program} -e`;
      if (!keys.includes(key)) keys.push(key);
      continue;
    }
    const args = words.slice(1).filter((w, i, rest) => !w.startsWith("-") && !["--cwd", "--prefix", "-C"].includes(rest[i - 1] ?? ""));
    const sub = args[0];
    let key = sub && /^[a-z][a-z0-9:._-]*$/.test(sub) ? `${program} ${sub}` : program;
    // A script runner's script is the real need: "bun run test", not
    // "bun run" (which also covers the always-granted typecheck).
    const script = args[1];
    if (RUNNERS.has(program) && sub === "run" && script && /^[a-z][a-z0-9:._-]*$/.test(script)) key = `${key} ${script}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** First word of a shell line past assignments, for a descriptive key
 *  when commandKeys finds none ("shell" when there is no word). */
function firstProgram(command: string): string {
  for (const w of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    const name = w.replace(/^.*\//, "").replace(/[^\w.+@-]/g, "");
    return name || "shell";
  }
  return "shell";
}

/** Comparable keys for a run's raw `permission_denials`, deduplicated,
 *  first seen first: "Bash: bun install", "Write" (non-Bash tools by
 *  name). Anything malformed is skipped, never thrown on. */
export function summarizeDenials(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const add = (k: string) => {
    if (!out.includes(k)) out.push(k);
  };
  for (const d of raw) {
    if (typeof d !== "object" || d === null) continue;
    const tool = (d as { tool_name?: unknown }).tool_name;
    if (typeof tool !== "string" || tool === "") continue;
    const input = (d as { tool_input?: unknown }).tool_input;
    const command = typeof input === "object" && input !== null ? (input as { command?: unknown }).command : undefined;
    if (tool === "Bash" && typeof command === "string") {
      const keys = commandKeys(command);
      // A command with no key (a helper like cat, or a bare heredoc) is
      // still a refusal: say what it was, never a bare "Bash", which a
      // reviewer reads as "every Bash call was refused".
      if (keys.length === 0) add(command.includes("<<") ? "Bash: heredoc" : `Bash: ${firstProgram(command)} (shell form)`);
      for (const k of keys) add(`Bash: ${k}`);
    } else {
      add(tool);
    }
  }
  return out;
}

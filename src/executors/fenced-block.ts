/**
 * The body of the last ```<tag> fenced block in a model's raw output, or
 * null when there is none. Shared by every output-contract parser
 * (review-verdict, pipeline-handoff, mcp-approval-request).
 *
 * Same rule parse-subtask-plan.ts settled on: the opening fence is the
 * LAST `<fence><tag>` line in the text (a model that thinks out loud
 * with an earlier example block still gets its real one read), and the
 * closing fence is the LAST fence after it, not the nearest. Every
 * contract asks for its block to end the message, and the JSON inside
 * legitimately carries fences in its strings: a reviewer's feedback that
 * quotes a code sample, a handoff whose data holds markdown. The old
 * non-greedy `/```tag\s*\n([\s\S]*?)```/g` stopped at the first of
 * those, cut the JSON mid-string and failed the run as a contract
 * violation (caught live 2026-10-20: reviewer 093d0f69's approve verdict
 * quoted "and ``` still leaving exactly one closing fence", the parse
 * returned null and the card it reviewed stuck in pending-review).
 *
 * Where it would break: a message that keeps writing after its block and
 * uses another fence there. The body then runs into that prose, JSON.parse
 * fails and the caller fails closed, as it does for any other malformed
 * block.
 */
export function lastFencedBlock(rawOutput: string, tag: string): string | null {
  const marker = "```" + tag;
  let openIdx = rawOutput.lastIndexOf(marker);
  // The opening line must be the marker alone (trailing spaces allowed):
  // "```review-verdicts" or "```review-verdict foo" is not this block.
  // Walk back past any such near-miss to an earlier real opener.
  while (openIdx !== -1) {
    const lineEnd = rawOutput.indexOf("\n", openIdx + marker.length);
    if (lineEnd !== -1 && rawOutput.slice(openIdx + marker.length, lineEnd).trim() === "") {
      const rest = rawOutput.slice(lineEnd + 1);
      const closeIdx = rest.lastIndexOf("```");
      return closeIdx === -1 ? null : rest.slice(0, closeIdx);
    }
    openIdx = openIdx === 0 ? -1 : rawOutput.lastIndexOf(marker, openIdx - 1);
  }
  return null;
}

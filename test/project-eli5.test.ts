import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProjectEli5 } from "../src/services/project-eli5.ts";
import type { AnthropicMessagesClient } from "../src/executors/anthropic-api.ts";
import type Anthropic from "@anthropic-ai/sdk";

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `wissel-project-eli5-test-${prefix}-`));
}

/** Scripts one text response, and — the point of this test file — hands
 *  the actual prompt sent back to the caller via `capturedPrompt`, so
 *  tests can assert on what real content actually reached the model
 *  (the README/package.json text), not just that some call happened. */
function fakeClient(text: string, capture: { prompt?: string }): (apiKey?: string) => AnthropicMessagesClient {
  return () => ({
    messages: {
      create: async (params): Promise<Anthropic.Message> => {
        const content = params.messages[0]!.content;
        capture.prompt = typeof content === "string" ? content : JSON.stringify(content);
        return {
          id: "msg_1", type: "message", role: "assistant", model: params.model,
          content: [{ type: "text", text, citations: null }],
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
        } as Anthropic.Message;
      },
    },
  });
}

test("grounds the prompt in a real README and returns the model's paragraph", async () => {
  const dir = await tmp("readme");
  try {
    await writeFile(join(dir, "README.md"), "# Wissel\nRoutes tasks to a fleet of agents and skills.");
    const capture: { prompt?: string } = {};
    const result = await generateProjectEli5(dir, "wissel", { clientFactory: fakeClient("Wissel is a helper that hands your to-do items to the right robot.", capture) });

    expect(result).toEqual({ eli5: "Wissel is a helper that hands your to-do items to the right robot." });
    expect(capture.prompt).toContain("README (README.md)");
    expect(capture.prompt).toContain("Routes tasks to a fleet of agents and skills.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to package.json's name/description when there is no README", async () => {
  const dir = await tmp("pkg");
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "wissel", description: "Routes tasks to a fleet of agents and skills." }));
    const capture: { prompt?: string } = {};
    await generateProjectEli5(dir, "wissel", { clientFactory: fakeClient("summary", capture) });

    expect(capture.prompt).toContain("package.json:");
    expect(capture.prompt).toContain("name: wissel");
    expect(capture.prompt).toContain("description: Routes tasks to a fleet of agents and skills.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to a directory listing when neither README nor package.json exist", async () => {
  const dir = await tmp("bare");
  try {
    await writeFile(join(dir, "main.py"), "print('hi')");
    const capture: { prompt?: string } = {};
    await generateProjectEli5(dir, "mystery-project", { clientFactory: fakeClient("summary", capture) });

    expect(capture.prompt).toContain("No README or package.json description found");
    expect(capture.prompt).toContain("main.py");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty model response is an error, not a cached empty string", async () => {
  const dir = await tmp("empty");
  try {
    await writeFile(join(dir, "README.md"), "content");
    const result = await generateProjectEli5(dir, "x", { clientFactory: fakeClient("", {}) });
    expect(result).toEqual({ error: "empty response from the model" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a client that throws surfaces a real error instead of crashing", async () => {
  const dir = await tmp("throws");
  try {
    await writeFile(join(dir, "README.md"), "content");
    const throwingClient: (apiKey?: string) => AnthropicMessagesClient = () => ({
      messages: { create: async () => { throw new Error("network down"); } },
    });
    const result = await generateProjectEli5(dir, "x", { clientFactory: throwingClient });
    expect(result).toEqual({ error: "network down" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { describe, expect, it, vi } from "vitest";
import { captureStream as collectStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => {
  const createLinkPreviewClient = vi.fn(() => {
    return {
      fetchLinkContent: vi.fn(async (url: string) => {
        return {
          url,
          title: "Example",
          description: null,
          siteName: null,
          content: "Hello world",
          truncated: false,
          totalCharacters: 11,
          wordCount: 2,
          transcriptCharacters: null,
          transcriptLines: null,
          transcriptWordCount: null,
          transcriptSource: null,
          transcriptionProvider: null,
          transcriptMetadata: null,
          transcriptSegments: null,
          transcriptTimedText: null,
          mediaDurationSeconds: null,
          video: null,
          isVideoOnly: false,
          diagnostics: {
            strategy: "html",
            cacheMode: "default",
            cacheStatus: "miss",
            firecrawl: { used: false },
            markdown: { used: false, provider: null },
            transcript: {
              cacheMode: "default",
              cacheStatus: "miss",
              textProvided: false,
              provider: null,
              attemptedProviders: [],
              notes: null,
            },
          },
        };
      }),
    };
  });

  const resolveCliBinary = vi.fn(() => process.execPath);
  const isCliDisabled = vi.fn(() => false);
  const runCliModel = vi.fn(async () => {
    return {
      text: "CLI summary",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costUsd: 0.0123,
    };
  });

  return { createLinkPreviewClient, resolveCliBinary, isCliDisabled, runCliModel };
});

vi.mock("../src/content/index.js", () => ({
  createLinkPreviewClient: mocks.createLinkPreviewClient,
}));

vi.mock("../src/llm/cli.js", () => ({
  resolveCliBinary: mocks.resolveCliBinary,
  isCliDisabled: mocks.isCliDisabled,
  runCliModel: mocks.runCliModel,
}));

import { runCli } from "../src/run.js";

describe("cli run.ts CLI provider model path", () => {
  it("summarizes via cli/<provider> and includes metrics finish line", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    (stderr.stream as unknown as { isTTY?: boolean }).isTTY = false;

    await runCli(
      [
        "--model",
        "cli/codex/gpt-5.2",
        "--metrics",
        "detailed",
        "--timeout",
        "2s",
        "https://example.com",
      ],
      {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(stdout.getText()).toContain("CLI summary");
    expect(mocks.runCliModel).toHaveBeenCalled();
    expect(stderr.getText()).toMatch(/cli\/codex\/gpt-5\.2/);
  });
});

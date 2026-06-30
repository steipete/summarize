import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(async () => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5-chat",
    stopReason: "stop",
    timestamp: Date.now(),
    content: [{ type: "text", text: "SUMMARY" }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  })),
  resolveTranscriptForLink: vi.fn(async (...args: unknown[]) => {
    return typeof args[0] === "string" && args[0].includes("youtube.com/watch")
      ? {
          text: "HELLO FROM TEST",
          source: "youtube",
          diagnostics: {
            cacheMode: "default",
            cacheStatus: "miss",
            textProvided: true,
            provider: "youtube",
            attemptedProviders: ["youtube"],
            notes: null,
          },
        }
      : {
          text: null,
          source: null,
          diagnostics: {
            cacheMode: "default",
            cacheStatus: "miss",
            textProvided: false,
            provider: null,
            attemptedProviders: [],
            notes: null,
          },
        };
  }),
}));

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: () => {
    throw new Error("unexpected pi-ai streamSimple call");
  },
  getModel: () => {
    throw new Error("no model");
  },
}));

vi.mock("../packages/core/src/content/transcript/index.js", () => ({
  resolveTranscriptForLink: mocks.resolveTranscriptForLink,
}));

const collectStdout = () => {
  let text = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stdout, getText: () => text };
};

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

describe("--model auto (YouTube)", () => {
  it("uses an LLM and does not print the transcript", async () => {
    mocks.completeSimple.mockClear();
    mocks.resolveTranscriptForLink.mockClear();

    const youtubeUrl = "https://www.youtube.com/watch?v=EYSQGkpuzAA&t=69s";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === youtubeUrl) {
        return htmlResponse(
          "<!doctype html><html><head><title>Video</title></head><body>ok</body></html>",
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const out = collectStdout();
    await runCli(["--model", "auto", "--timeout", "2s", youtubeUrl], {
      env: { OPENAI_API_KEY: "test", OPENAI_BASE_URL: "not a url" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: silentStderr,
    });

    expect(out.getText()).toMatch(/summary/i);
    expect(out.getText()).not.toContain("Transcript:");
    expect(out.getText()).not.toContain("HELLO FROM TEST");
    expect(mocks.completeSimple).toHaveBeenCalled();
    expect(mocks.resolveTranscriptForLink).toHaveBeenCalled();
  });
});

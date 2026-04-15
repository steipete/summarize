import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

function collectStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
}

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    completeSimple: mocks.completeSimple,
  };
});

describe("cli media API key mapping reproduction", () => {
  it("should NOT fail with 'Media file transcription requires' when OPENAI_API_KEY is provided", async () => {
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "Audio summary." }],
      usage: { input: 1, output: 1, totalTokens: 2 },
    });

    const root = mkdtempSync(join(tmpdir(), "summarize-media-key-repro-"));
    const mp3Path = join(root, "test-audio.mp3");
    // Minimal valid-ish MP3 header to pass some basic checks if any
    writeFileSync(mp3Path, Buffer.from([0xff, 0xfb, 0x10, 0x00]));

    const summarizeDir = join(root, ".summarize");
    const cacheDir = join(summarizeDir, "cache");
    mkdirSync(cacheDir, { recursive: true });

    // Mock LiteLLM catalog
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({ "gpt-4o-mini": { max_input_tokens: 128000 } }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : "url" in input ? input.url : input.toString();
      
      if (url.includes("api.openai.com/v1/audio/transcriptions")) {
        return new Response(JSON.stringify({
          text: "Transcribed text from Whisper."
        }));
      }
      
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const stdout = collectStream();
    const stderr = collectStream();

    // The bug was that OPENAI_API_KEY was in env but NOT correctly passed to the media flow's apiStatus
    // in runner-contexts.ts, so it would throw the "Media file transcription requires" error
    // because it thinks no provider is configured.
    
    await runCli(
      [
        "--model",
        "openai/gpt-4o",
        "--metrics",
        "off",
        mp3Path,
      ],
      {
        env: { 
          HOME: root, 
          OPENAI_API_KEY: "test-openai-key",
          PATH: process.env.PATH
        },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    // If it succeeds, it means the key WAS passed (or the bug is fixed)
    expect(fetchMock).toHaveBeenCalled();
    const whisperCall = fetchMock.mock.calls.find(call => 
      (typeof call[0] === "string" ? call[0] : call[0].url).includes("/audio/transcriptions")
    );
    expect(whisperCall, "Should have called OpenAI Whisper API").toBeDefined();

    globalFetchSpy.mockRestore();
  }, 30_000);
});

import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createLinkPreviewClient = vi.hoisted(() => vi.fn());
const fetchLinkContent = vi.hoisted(() => vi.fn());

vi.mock("../src/content/index.js", () => ({
  createLinkPreviewClient,
  resolveTranscriptionAvailability: vi.fn(async () => ({ hasAnyProvider: true })),
}));

import { runCli } from "../src/run.js";

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

describe("cli media file path and cache wiring", () => {
  beforeEach(() => {
    fetchLinkContent.mockReset();
    fetchLinkContent.mockResolvedValue({
      content: "Transcript from media",
      diagnostics: { transcript: { provider: "test" } },
    });
    createLinkPreviewClient.mockReset();
    createLinkPreviewClient.mockReturnValue({ fetchLinkContent });
  });

  it("resolves relative media paths to file URLs and forwards fileMtime", async () => {
    const previousCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "summarize-media-path-cache-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });
    const audioPath = join(root, "relative.mp3");
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]));
    const expectedMtime = statSync(audioPath).mtimeMs;

    const stdout = collectStream();
    const stderr = collectStream();
    try {
      process.chdir(root);
      await runCli(["--extract", "--timeout", "2s", "relative.mp3"], {
        env: {
          HOME: root,
          GROQ_API_KEY: "gsk_test",
          SUMMARIZE_WHISPER_CPP_BINARY: "whisper-cli",
          YT_DLP_PATH: "yt-dlp",
        },
        fetch: vi.fn(async () => {
          throw new Error("unexpected fetch");
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(createLinkPreviewClient).toHaveBeenCalledTimes(1);
    expect(fetchLinkContent).toHaveBeenCalledWith(
      pathToFileURL(realpathSync(audioPath)).href,
      expect.objectContaining({
        cacheMode: "default",
        fileMtime: expectedMtime,
        mediaTranscript: "prefer",
      }),
    );
    expect(stdout.getText()).toBe("Transcript from media\n");
    expect(stderr.getText()).toBe("");
  });
});

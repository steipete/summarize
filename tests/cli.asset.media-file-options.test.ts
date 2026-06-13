import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { CacheStore } from "../src/cache.js";
import type { ExtractedLinkContent } from "../src/content/index.js";
import { executeMediaFile } from "../src/run/flows/asset/media.js";
import type { AssetSummaryContext } from "../src/run/flows/asset/types.js";

const contentMocks = vi.hoisted(() => ({
  createLinkPreviewClient: vi.fn(),
  resolveTranscriptionAvailability: vi.fn(async () => ({ hasAnyProvider: true })),
}));

vi.mock("../src/content/index.js", () => ({
  ...contentMocks,
}));

const { createLinkPreviewClient } = contentMocks;

function makeContext(overrides: Partial<AssetSummaryContext>): AssetSummaryContext {
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return {
    env: { OPENAI_API_KEY: "test-key" },
    envForRun: { OPENAI_API_KEY: "test-key" },
    apiStatus: {
      xaiApiKey: null,
      apiKey: null,
      nvidiaApiKey: null,
      minimaxApiKey: null,
      openrouterApiKey: null,
      apifyToken: null,
      firecrawlConfigured: false,
      googleConfigured: false,
      anthropicConfigured: false,
      providerBaseUrls: { openai: null, anthropic: null, google: null, xai: null },
      zaiApiKey: null,
      zaiBaseUrl: "",
      nvidiaBaseUrl: "",
      minimaxBaseUrl: "",
      ollamaBaseUrl: "",
      falApiKey: null,
      groqApiKey: null,
      assemblyaiApiKey: null,
      elevenlabsApiKey: null,
      googleApiKey: null,
      openaiApiKey: "test-key",
    },
    trackedFetch: vi.fn(),
    cache: { mode: "default", store: null, ttlMs: 0, maxBytes: 0, path: null },
    summaryCacheBypass: false,
    mediaCache: null,
    timeoutMs: 1234,
    transcriptTimestamps: false,
    transcriptDiarization: null,
    forceSummary: false,
    stderr,
    verbose: false,
    verboseColor: false,
    ...overrides,
  } as AssetSummaryContext;
}

describe("executeMediaFile options", () => {
  it("returns extracted transcripts without presenting them", async () => {
    createLinkPreviewClient.mockReset();
    const root = mkdtempSync(join(tmpdir(), "summarize-media-execution-"));
    const audioPath = join(root, "audio.mp3");
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]));
    const extracted = {
      url: `file://${audioPath}`,
      title: "Audio",
      content: "Transcript text",
      diagnostics: { transcript: { provider: "openai" } },
    } as ExtractedLinkContent;
    createLinkPreviewClient.mockReturnValue({
      fetchLinkContent: vi.fn(async () => extracted),
    });
    let stdoutText = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        callback();
      },
    });
    const clearProgressForStdout = vi.fn();
    const ctx = makeContext({
      env: {
        OPENAI_API_KEY: "test-key",
        YT_DLP_PATH: "yt-dlp",
        SUMMARIZE_WHISPER_CPP_BINARY: "whisper-cli",
      },
      extractMode: true,
      stdout,
      clearProgressForStdout,
    });

    const result = await executeMediaFile(ctx, {
      sourceKind: "file",
      sourceLabel: audioPath,
      attachment: {
        kind: "file",
        mediaType: "audio/mpeg",
        filename: "audio.mp3",
        bytes: new Uint8Array(),
      },
    });

    expect(result).toEqual({ kind: "extraction", extracted });
    expect(stdoutText).toBe("");
    expect(clearProgressForStdout).not.toHaveBeenCalled();
  });

  it("passes timeout/cacheMode and bypasses transcript cache when cache is disabled", async () => {
    createLinkPreviewClient.mockReset();
    const root = mkdtempSync(join(tmpdir(), "summarize-media-options-bypass-"));
    const audioPath = join(root, "audio.mp3");
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]));

    let capturedClientOptions: { transcriptCache?: unknown | null } | null = null;
    let capturedFetchOptions: { cacheMode?: string; timeoutMs?: number } | null = null;

    createLinkPreviewClient.mockImplementation((options: unknown) => {
      capturedClientOptions = options;
      return {
        fetchLinkContent: async (_url: string, optionsArg: unknown) => {
          capturedFetchOptions = optionsArg;
          throw new Error("boom");
        },
      };
    });

    const ctx = makeContext({
      cache: {
        mode: "bypass",
        store: { transcriptCache: {} } as CacheStore,
        ttlMs: 0,
        maxBytes: 0,
        path: null,
      },
      timeoutMs: 3456,
    });

    await expect(
      executeMediaFile(ctx, {
        sourceKind: "file",
        sourceLabel: audioPath,
        attachment: {
          kind: "file",
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
          bytes: new Uint8Array(),
        },
      }),
    ).rejects.toThrow(/Transcription failed/);

    expect(capturedClientOptions?.transcriptCache ?? null).toBeNull();
    expect(capturedFetchOptions?.cacheMode).toBe("bypass");
    expect(capturedFetchOptions?.timeoutMs).toBe(3456);
  });

  it("uses transcript cache and default cache mode when enabled", async () => {
    createLinkPreviewClient.mockReset();
    const root = mkdtempSync(join(tmpdir(), "summarize-media-options-default-"));
    const audioPath = join(root, "audio.mp3");
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]));

    let capturedClientOptions: { transcriptCache?: unknown | null } | null = null;
    let capturedFetchOptions: { cacheMode?: string; timeoutMs?: number } | null = null;

    const transcriptCache = {};

    createLinkPreviewClient.mockImplementation((options: unknown) => {
      capturedClientOptions = options;
      return {
        fetchLinkContent: async (_url: string, optionsArg: unknown) => {
          capturedFetchOptions = optionsArg;
          throw new Error("boom");
        },
      };
    });

    const ctx = makeContext({
      cache: {
        mode: "default",
        store: { transcriptCache } as CacheStore,
        ttlMs: 0,
        maxBytes: 0,
        path: null,
      },
      timeoutMs: 5678,
    });

    await expect(
      executeMediaFile(ctx, {
        sourceKind: "file",
        sourceLabel: audioPath,
        attachment: {
          kind: "file",
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
          bytes: new Uint8Array(),
        },
      }),
    ).rejects.toThrow(/Transcription failed/);

    expect(capturedClientOptions?.transcriptCache).toBe(transcriptCache);
    expect(capturedFetchOptions?.cacheMode).toBe("default");
    expect(capturedFetchOptions?.timeoutMs).toBe(5678);
  });

  it("passes diarization, timestamps, and ElevenLabs credentials to media extraction", async () => {
    createLinkPreviewClient.mockReset();
    const root = mkdtempSync(join(tmpdir(), "summarize-media-options-diarize-"));
    const videoPath = join(root, "interview.mp4");
    writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18]));

    let capturedClientOptions: {
      transcription?: {
        elevenlabsApiKey?: string | null;
        openaiApiKey?: string | null;
      };
    } | null = null;
    let capturedFetchOptions: {
      transcriptDiarization?: string | null;
      transcriptTimestamps?: boolean;
    } | null = null;

    createLinkPreviewClient.mockImplementation((options: unknown) => {
      capturedClientOptions = options;
      return {
        fetchLinkContent: async (_url: string, optionsArg: unknown) => {
          capturedFetchOptions = optionsArg;
          throw new Error("boom");
        },
      };
    });

    const ctx = makeContext({
      env: { ELEVENLABS_API_KEY: "eleven-test" },
      envForRun: { ELEVENLABS_API_KEY: "eleven-test" },
      transcriptDiarization: "elevenlabs",
      transcriptTimestamps: true,
    });

    await expect(
      executeMediaFile(ctx, {
        sourceKind: "file",
        sourceLabel: videoPath,
        attachment: {
          kind: "file",
          mediaType: "video/mp4",
          filename: "interview.mp4",
          bytes: new Uint8Array(),
        },
      }),
    ).rejects.toThrow(/Transcription failed/);

    expect(capturedClientOptions?.transcription?.elevenlabsApiKey).toBe("eleven-test");
    expect(capturedFetchOptions).toMatchObject({
      transcriptDiarization: "elevenlabs",
      transcriptTimestamps: true,
    });
  });
});

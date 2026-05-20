import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheState } from "../src/cache.js";
import { createDaemonUrlFlowContext } from "../src/daemon/flow-context.js";
import { resolveSlideSettings } from "../src/slides/settings.js";
import type { SlideExtractionResult } from "../src/slides/types.js";

vi.mock("../src/slides/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/slides/index.js")>("../src/slides/index.js");
  return {
    ...actual,
    extractSlidesForSource: vi.fn(),
  };
});

import { runUrlFlow } from "../src/run/flows/url/flow.js";
import * as slidesModule from "../src/slides/index.js";

const extractSlidesForSource = vi.mocked(slidesModule.extractSlidesForSource);

const makeSlides = (url: string): SlideExtractionResult => ({
  sourceUrl: url,
  sourceKind: "youtube",
  sourceId: "abc123def45",
  slidesDir: "/tmp/slides",
  sceneThreshold: 0.3,
  autoTuneThreshold: true,
  autoTune: { enabled: false, chosenThreshold: 0, confidence: 0, strategy: "none" },
  maxSlides: 100,
  minSlideDuration: 2,
  ocrRequested: false,
  ocrAvailable: false,
  slides: [{ index: 1, timestamp: 1.2, imagePath: "/tmp/slide_0001.png" }],
  warnings: [],
});

const waitForResult = async (
  getter: () => { ok: boolean; error?: string | null } | null,
  timeoutMs = 5000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for slides done hook"));
    }, timeoutMs);
    const poll = () => {
      if (getter()) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });

afterEach(() => {
  vi.resetAllMocks();
});

describe("runUrlFlow slides done hook", () => {
  it("emits ok when slides finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-slides-done-"));
    const url = "https://www.youtube.com/watch?v=abc123def45";
    const content =
      "<!doctype html><html><head><title>Video</title></head><body>Test</body></html>";

    extractSlidesForSource.mockResolvedValueOnce(makeSlides(url));

    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (requestUrl !== url) {
        throw new Error(`unexpected fetch: ${requestUrl}`);
      }
      return new Response(content, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const cache: CacheState = {
      mode: "bypass",
      store: null,
      ttlMs: 0,
      maxBytes: 0,
      path: null,
    };

    const slides = resolveSlideSettings({ slides: true, cwd: root });
    expect(slides).not.toBeNull();
    if (!slides) {
      throw new Error("Expected slides settings to be available.");
    }

    let doneResult: { ok: boolean; error?: string | null } | null = null;
    const mediaCache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => null),
    };

    const ctx = createDaemonUrlFlowContext({
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetchImpl,
      urlFetchImpl: fetchImpl,
      cache,
      mediaCache,
      modelOverride: "openai/gpt-5.2",
      promptOverride: null,
      lengthRaw: "short",
      languageRaw: "auto",
      maxExtractCharacters: null,
      slides,
      hooks: {
        onSlidesDone: (result) => {
          doneResult = result;
        },
      },
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    ctx.flags.extractMode = true;

    await runUrlFlow({ ctx, url, isYoutubeUrl: true });

    await waitForResult(() => doneResult);
    expect(doneResult?.ok).toBe(true);
    const call = extractSlidesForSource.mock.calls[0]?.[0];
    expect(call?.mediaCache).toBe(mediaCache);
    expect(call?.ytDlpPath).toBeNull();
    expect(call?.disableYtDlpAutoResolve).toBe(true);
    expect(call?.allowRemoteUrlFallback).toBe(false);
  });

  it("emits error when slides extraction fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-slides-done-"));
    const url = "https://www.youtube.com/watch?v=abc123def45";
    const content =
      "<!doctype html><html><head><title>Video</title></head><body>Test</body></html>";

    extractSlidesForSource.mockRejectedValueOnce(new Error("slides failed"));

    const fetchImpl: typeof fetch = async (input) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (requestUrl !== url) {
        throw new Error(`unexpected fetch: ${requestUrl}`);
      }
      return new Response(content, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const cache: CacheState = {
      mode: "bypass",
      store: null,
      ttlMs: 0,
      maxBytes: 0,
      path: null,
    };

    const slides = resolveSlideSettings({ slides: true, cwd: root });
    expect(slides).not.toBeNull();
    if (!slides) {
      throw new Error("Expected slides settings to be available.");
    }

    let doneResult: { ok: boolean; error?: string | null } | null = null;

    const ctx = createDaemonUrlFlowContext({
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetchImpl,
      cache,
      modelOverride: "openai/gpt-5.2",
      promptOverride: null,
      lengthRaw: "short",
      languageRaw: "auto",
      maxExtractCharacters: null,
      slides,
      hooks: {
        onSlidesDone: (result) => {
          doneResult = result;
        },
      },
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    ctx.flags.extractMode = true;

    await runUrlFlow({ ctx, url, isYoutubeUrl: true });

    await waitForResult(() => doneResult);
    expect(doneResult?.ok).toBe(false);
    expect(doneResult?.error).toContain("slides failed");
  });
});

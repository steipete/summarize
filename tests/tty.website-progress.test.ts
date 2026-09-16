import { describe, expect, it, vi } from "vitest";
import { createWebsiteProgress } from "../src/tty/website-progress.js";

describe("tty website progress", () => {
  it("renders Syndication progress in Turkish and preserves byte counts", () => {
    const setText = vi.fn();
    const progress = createWebsiteProgress({ enabled: true, spinner: { setText }, locale: "tr" });
    progress?.onProgress({
      kind: "twitter-syndication-start",
      url: "https://x.com/example/status/20",
    });
    expect(setText).toHaveBeenLastCalledWith("X: Syndication API üzerinden alınıyor…");
    progress?.onProgress({
      kind: "twitter-syndication-done",
      url: "https://x.com/example/status/20",
      ok: false,
      textBytes: null,
    });
    expect(setText).toHaveBeenLastCalledWith("X: Syndication başarısız; alternatif deneniyor…");
    progress?.onProgress({
      kind: "twitter-syndication-done",
      url: "https://x.com/example/status/20",
      ok: true,
      textBytes: 1024,
    });
    expect(setText).toHaveBeenLastCalledWith("X: 1,0 KB alındı…");
  });
  it("returns null when disabled", () => {
    expect(createWebsiteProgress({ enabled: false, spinner: { setText: vi.fn() } })).toBeNull();
  });

  it("renders fetch progress with ticker + rate and stops ticking after done", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const setText = vi.fn();
    const progress = createWebsiteProgress({ enabled: true, spinner: { setText } });
    expect(progress).not.toBeNull();
    if (!progress) return;

    progress.onProgress({ kind: "fetch-html-start", url: "https://example.com" });
    expect(setText).toHaveBeenLastCalledWith("Fetching website (connecting)…");

    vi.advanceTimersByTime(1_000);
    expect(setText).toHaveBeenLastCalledWith("Fetching website (connecting, 1.0s)…");

    vi.setSystemTime(3_000);
    progress.onProgress({
      kind: "fetch-html-progress",
      url: "https://example.com",
      downloadedBytes: 2048,
      totalBytes: 4096,
    });
    expect(setText).toHaveBeenLastCalledWith("Fetching website (2.0 KB/4.0 KB, 2.0s, 1.0 KB/s)…");

    progress.onProgress({
      kind: "fetch-html-done",
      url: "https://example.com",
      downloadedBytes: 2048,
      totalBytes: 4096,
    });

    const callsAfterDone = setText.mock.calls.length;
    vi.advanceTimersByTime(2_000);
    expect(setText.mock.calls.length).toBe(callsAfterDone);

    vi.useRealTimers();
  });

  it("renders other phases", () => {
    const setText = vi.fn();
    const progress = createWebsiteProgress({ enabled: true, spinner: { setText } });
    expect(progress).not.toBeNull();
    if (!progress) return;

    progress.onProgress({ kind: "bird-start", url: "https://x.com/test/status/1", client: null });
    expect(setText).toHaveBeenLastCalledWith("X: reading tweet…");

    progress.onProgress({
      kind: "bird-done",
      url: "https://x.com/test/status/1",
      client: "xurl",
      ok: false,
      textBytes: null,
    });
    expect(setText).toHaveBeenLastCalledWith("Xurl: failed; fallback…");

    progress.onProgress({ kind: "nitter-start", url: "https://x.com/test/status/1" });
    expect(setText).toHaveBeenLastCalledWith("Nitter: fetching…");

    progress.onProgress({
      kind: "nitter-done",
      url: "https://x.com/test/status/1",
      ok: true,
      textBytes: 999,
    });
    expect(setText).toHaveBeenLastCalledWith("Nitter: got 999 B…");

    progress.onProgress({
      kind: "firecrawl-start",
      url: "https://example.com",
      reason: "Blocked / thin HTML",
    });
    expect(setText).toHaveBeenLastCalledWith("Firecrawl: scraping (fallback: blocked/thin HTML)…");

    progress.onProgress({
      kind: "firecrawl-done",
      url: "https://example.com",
      ok: true,
      markdownBytes: 10 * 1024,
      htmlBytes: null,
    });
    expect(setText).toHaveBeenLastCalledWith("Firecrawl: got 10 KB…");

    progress.onProgress({
      kind: "transcript-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      hint: "Podcast: resolving transcript",
    });
    expect(setText).toHaveBeenLastCalledWith("Podcast: resolving transcript…");

    progress.onProgress({
      kind: "transcript-done",
      url: "https://podcasts.example/episode",
      ok: true,
      service: "podcast",
      source: "whisper",
      hint: null,
    });
    expect(setText).toHaveBeenLastCalledWith("Transcribed…");
  });

  it("renders podcast download + whisper progress", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const setText = vi.fn();
    const progress = createWebsiteProgress({ enabled: true, spinner: { setText } });
    expect(progress).not.toBeNull();
    if (!progress) return;

    progress.onProgress({
      kind: "transcript-media-download-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      mediaUrl: "https://cdn.example/episode.mp3",
      totalBytes: 15 * 1024,
    });
    expect(setText).toHaveBeenLastCalledWith("Downloading audio…");

    vi.setSystemTime(163_000);
    progress.onProgress({
      kind: "transcript-media-download-progress",
      url: "https://podcasts.example/episode",
      service: "podcast",
      downloadedBytes: 136 * 1024,
      totalBytes: 15 * 1024,
    });
    expect(setText).toHaveBeenLastCalledWith(
      expect.stringContaining("Downloading audio (podcast, 136 KB, 2m 42s"),
    );
    expect(setText).toHaveBeenLastCalledWith(expect.stringContaining("B/s"));
    expect(setText).toHaveBeenLastCalledWith(expect.not.stringContaining("2m42s"));

    progress.onProgress({
      kind: "transcript-media-download-done",
      url: "https://podcasts.example/episode",
      service: "podcast",
      downloadedBytes: 136 * 1024,
      totalBytes: 15 * 1024,
    });

    vi.setSystemTime(163_000);
    progress.onProgress({
      kind: "transcript-whisper-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      providerHint: "openai",
      modelId: "whisper-1",
      totalDurationSeconds: 3600,
      parts: 6,
    });
    expect(setText).toHaveBeenLastCalledWith(
      expect.stringContaining("Transcribing (podcast, Whisper/OpenAI, whisper-1"),
    );

    vi.setSystemTime(288_000);
    progress.onProgress({
      kind: "transcript-whisper-progress",
      url: "https://podcasts.example/episode",
      service: "podcast",
      processedDurationSeconds: 600,
      totalDurationSeconds: 3600,
      partIndex: 1,
      parts: 6,
    });
    const last = setText.mock.calls.at(-1)?.[0] ?? "";
    expect(last).toContain("10m/1h");
    expect(last).toContain("1/6");
    expect(last).toContain("2m 5s");

    vi.useRealTimers();
  });

  it("renders whisper provider hints and optional duration/parts", () => {
    const setText = vi.fn();
    const progress = createWebsiteProgress({ enabled: true, spinner: { setText } });
    expect(progress).not.toBeNull();
    if (!progress) return;

    progress.onProgress({
      kind: "transcript-whisper-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      providerHint: "fal",
      modelId: "fal-ai/wizper",
      totalDurationSeconds: null,
      parts: null,
    });
    expect(setText).toHaveBeenLastCalledWith(expect.stringContaining("Whisper/FAL, fal-ai/wizper"));

    progress.onProgress({
      kind: "transcript-whisper-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      providerHint: "openai->fal",
      modelId: "whisper-1->fal-ai/wizper",
      totalDurationSeconds: 44,
      parts: null,
    });
    expect(setText).toHaveBeenLastCalledWith(expect.stringContaining("Whisper/OpenAI, whisper-1"));
    expect(setText).toHaveBeenLastCalledWith(expect.not.stringContaining("FAL"));
    expect(setText).toHaveBeenLastCalledWith(expect.stringContaining("44s"));

    progress.onProgress({
      kind: "transcript-whisper-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      providerHint: "assemblyai",
      modelId: "assemblyai/universal-2",
      totalDurationSeconds: 25,
      parts: null,
    });
    expect(setText).toHaveBeenLastCalledWith(
      expect.stringContaining("AssemblyAI, assemblyai/universal-2"),
    );

    progress.onProgress({
      kind: "transcript-whisper-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      providerHint: "gemini",
      modelId: "google/gemini-2.5-flash",
      totalDurationSeconds: 30,
      parts: null,
    });
    expect(setText).toHaveBeenLastCalledWith(
      expect.stringContaining("Gemini, google/gemini-2.5-flash"),
    );

    progress.onProgress({
      kind: "transcript-whisper-start",
      url: "https://podcasts.example/episode",
      service: "podcast",
      providerHint: "unknown",
      modelId: null,
      totalDurationSeconds: null,
      parts: 3,
    });
    expect(setText).toHaveBeenLastCalledWith(
      expect.stringContaining("Transcribing (podcast, Whisper"),
    );
  });
});

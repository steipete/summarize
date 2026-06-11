import { describe, expect, it, vi } from "vitest";
import {
  extractYoutubeAudioFromWatchHtml,
  extractYoutubePlayerBootstrap,
  resolveYoutubeAudio,
  resolveYoutubeAudioWithAndroidVr,
} from "../packages/core/src/content/youtube.js";

describe("YouTube Android VR media resolver", () => {
  it("extracts player bootstrap values from watch HTML", () => {
    expect(
      extractYoutubePlayerBootstrap(
        '<script>ytcfg.set({"INNERTUBE_API_KEY":"KEY","VISITOR_DATA":"VISITOR"});</script>',
      ),
    ).toEqual({ apiKey: "KEY", visitorData: "VISITOR" });
  });

  it("selects the highest bitrate direct audio format", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          playabilityStatus: { status: "OK" },
          streamingData: {
            adaptiveFormats: [
              {
                itag: 139,
                url: "https://media.example/low",
                mimeType: 'audio/mp4; codecs="mp4a.40.5"',
                bitrate: 48_000,
                contentLength: "100",
                approxDurationMs: "120000",
              },
              {
                itag: 251,
                url: "https://media.example/high",
                mimeType: 'audio/webm; codecs="opus"',
                bitrate: 128_000,
                contentLength: "200",
                approxDurationMs: "120000",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await resolveYoutubeAudioWithAndroidVr({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      videoId: "abcdefghijk",
      apiKey: "KEY",
      visitorData: "VISITOR",
    });

    expect(result).toEqual({
      url: "https://media.example/high",
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: 128_000,
      contentLength: 200,
      durationSeconds: 120,
      filename: "youtube-251.webm",
    });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      "X-Youtube-Client-Name": "28",
      "X-Youtube-Client-Version": "1.65.10",
      "X-Goog-Visitor-Id": "VISITOR",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      videoId: "abcdefghijk",
      context: { client: { clientName: "ANDROID_VR", clientVersion: "1.65.10" } },
    });
  });

  it("reports player restrictions", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" },
        }),
        { status: 200 },
      );
    });

    await expect(
      resolveYoutubeAudioWithAndroidVr({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        videoId: "abcdefghijk",
        apiKey: "KEY",
      }),
    ).rejects.toThrow(/LOGIN_REQUIRED.*confirm your age/);
  });

  it("honors an explicit browser decoding format preference", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          playabilityStatus: { status: "OK" },
          streamingData: {
            adaptiveFormats: [
              {
                itag: 140,
                url: "https://media.example/aac",
                mimeType: 'audio/mp4; codecs="mp4a.40.2"',
                bitrate: 129_000,
              },
              {
                itag: 251,
                url: "https://media.example/opus",
                mimeType: 'audio/webm; codecs="opus"',
                bitrate: 152_000,
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const result = await resolveYoutubeAudioWithAndroidVr({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      videoId: "abcdefghijk",
      apiKey: "KEY",
      preferredMimeTypes: ["audio/mp4", "audio/webm"],
    });

    expect(result.url).toBe("https://media.example/aac");
  });

  it("prefers a direct audio URL embedded in the watch page", async () => {
    const fetchImpl = vi.fn();
    const watchHtml = `<script>var ytInitialPlayerResponse = ${JSON.stringify({
      streamingData: {
        adaptiveFormats: [
          {
            itag: 140,
            url: "https://media.example/watch-audio",
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 129_000,
            contentLength: "321",
            approxDurationMs: "45000",
          },
        ],
      },
    })};</script>`;

    expect(extractYoutubeAudioFromWatchHtml(watchHtml)).toMatchObject({
      url: "https://media.example/watch-audio",
      filename: "youtube-140.m4a",
    });
    await expect(
      resolveYoutubeAudio({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        videoId: "abcdefghijk",
        apiKey: "KEY",
        watchHtml,
      }),
    ).resolves.toMatchObject({
      url: "https://media.example/watch-audio",
      resolver: "watch-page",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to Android VR when the watch page has no direct media", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            playabilityStatus: { status: "OK" },
            streamingData: {
              adaptiveFormats: [
                {
                  itag: 251,
                  url: "https://media.example/fallback",
                  mimeType: 'audio/webm; codecs="opus"',
                  bitrate: 128_000,
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(
      resolveYoutubeAudio({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        videoId: "abcdefghijk",
        apiKey: "KEY",
        watchHtml: "<html></html>",
      }),
    ).resolves.toMatchObject({
      url: "https://media.example/fallback",
      resolver: "android-vr",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

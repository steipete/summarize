import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserYoutubeMediaContext } from "../apps/chrome-extension/src/entrypoints/background/youtube-media";

const mocks = vi.hoisted(() => ({
  resolveYoutubeAudioWithAndroidVr: vi.fn(),
}));

vi.mock("@steipete/summarize-core/content/youtube", () => ({
  resolveYoutubeAudioWithAndroidVr: mocks.resolveYoutubeAudioWithAndroidVr,
}));

import { resolveYoutubeDirectAudio } from "../apps/chrome-extension/src/entrypoints/offscreen/youtube-audio";

describe("Chrome YouTube audio fallback", () => {
  beforeEach(() => {
    mocks.resolveYoutubeAudioWithAndroidVr.mockReset();
  });

  it("uses active player audio before making another resolver request", async () => {
    await expect(resolveYoutubeDirectAudio(createContext())).resolves.toMatchObject({
      mediaSource: "player",
      url: "https://player.example/audio.m4a",
    });
    expect(mocks.resolveYoutubeAudioWithAndroidVr).not.toHaveBeenCalled();
  });

  it("refreshes through Android VR after active player audio fails", async () => {
    mocks.resolveYoutubeAudioWithAndroidVr.mockResolvedValue({
      contentLength: 456,
      mimeType: "audio/webm",
      resolver: "android-vr",
      url: "https://android-vr.example/audio.webm",
    });

    await expect(
      resolveYoutubeDirectAudio(createContext(), { ignoreContextDirect: true }),
    ).resolves.toEqual({
      contentLength: 456,
      mediaSource: "android-vr",
      mimeType: "audio/webm",
      url: "https://android-vr.example/audio.webm",
    });
    expect(mocks.resolveYoutubeAudioWithAndroidVr).toHaveBeenCalledOnce();
  });
});

function createContext(): BrowserYoutubeMediaContext {
  return {
    apiKey: "api-key",
    directAudio: {
      contentLength: 123,
      mimeType: "audio/mp4",
      resolver: "player",
      url: "https://player.example/audio.m4a",
    },
    durationSeconds: 60,
    sabr: null,
    title: "Test video",
    url: "https://www.youtube.com/watch?v=test",
    videoId: "test",
    visitorData: null,
  };
}

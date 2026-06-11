export type BrowserYoutubeAdaptiveFormat = {
  itag: number;
  mimeType: string;
  bitrate: number;
  averageBitrate?: number;
  approxDurationMs?: string;
  contentLength?: string;
  lastModified?: string;
  xtags?: string;
  audioQuality?: string;
  audioTrackId?: string;
};

export type BrowserYoutubeMediaContext = {
  url: string;
  videoId: string;
  title: string | null;
  durationSeconds: number | null;
  apiKey: string;
  visitorData: string | null;
  directAudio: {
    url: string;
    mimeType: string;
    contentLength: number | null;
    resolver: "player" | "android-vr";
  } | null;
  sabr: {
    serverAbrStreamingUrl: string;
    videoPlaybackUstreamerConfig: string;
    clientName: number;
    clientVersion: string;
    formats: BrowserYoutubeAdaptiveFormat[];
  } | null;
};

export async function getYoutubeMediaContextInTab(
  tabId: number,
): Promise<BrowserYoutubeMediaContext | null> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (): BrowserYoutubeMediaContext | null => {
      type RecordLike = Record<string, unknown>;
      const isRecord = (value: unknown): value is RecordLike =>
        typeof value === "object" && value !== null;
      const stringValue = (value: unknown) =>
        typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
      const numberValue = (value: unknown) => {
        const parsed =
          typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number(value)
              : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
      };
      const activeVideoId = (() => {
        const url = new URL(location.href);
        return url.searchParams.get("v") ?? url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] ?? null;
      })();
      if (!activeVideoId) return null;

      const globals = globalThis as typeof globalThis & {
        ytInitialPlayerResponse?: unknown;
        ytcfg?: { get?: (key: string) => unknown; data_?: RecordLike };
      };
      const flexy = document.querySelector("ytd-watch-flexy") as
        | (Element & { playerData?: unknown; playerResponse?: unknown })
        | null;
      const moviePlayer = document.querySelector("#movie_player") as
        | (Element & { getPlayerResponse?: () => unknown })
        | null;
      const candidates = [
        moviePlayer?.getPlayerResponse?.(),
        flexy?.playerData,
        flexy?.playerResponse,
        globals.ytInitialPlayerResponse,
      ].filter(isRecord);
      const player =
        candidates.find((candidate) => {
          const details = isRecord(candidate.videoDetails) ? candidate.videoDetails : null;
          return stringValue(details?.videoId) === activeVideoId;
        }) ?? null;

      const getConfig = (key: string) =>
        globals.ytcfg?.get?.(key) ?? globals.ytcfg?.data_?.[key] ?? null;
      const apiKey = stringValue(getConfig("INNERTUBE_API_KEY"));
      if (!apiKey) return null;
      const context = isRecord(getConfig("INNERTUBE_CONTEXT"))
        ? (getConfig("INNERTUBE_CONTEXT") as RecordLike)
        : null;
      const contextClient = context && isRecord(context.client) ? context.client : null;
      const visitorData =
        stringValue(getConfig("VISITOR_DATA")) ?? stringValue(contextClient?.visitorData);
      const clientName =
        numberValue(getConfig("INNERTUBE_CONTEXT_CLIENT_NAME")) ??
        numberValue(contextClient?.clientName) ??
        1;
      const clientVersion =
        stringValue(getConfig("INNERTUBE_CONTEXT_CLIENT_VERSION")) ??
        stringValue(contextClient?.clientVersion) ??
        "2.20250101.00.00";

      const streamingData = player && isRecord(player.streamingData) ? player.streamingData : null;
      const playerConfig = player && isRecord(player.playerConfig) ? player.playerConfig : null;
      const mediaCommonConfig =
        playerConfig && isRecord(playerConfig.mediaCommonConfig)
          ? playerConfig.mediaCommonConfig
          : null;
      const ustreamerRequestConfig =
        mediaCommonConfig && isRecord(mediaCommonConfig.mediaUstreamerRequestConfig)
          ? mediaCommonConfig.mediaUstreamerRequestConfig
          : null;
      const serverAbrStreamingUrl = stringValue(streamingData?.serverAbrStreamingUrl);
      const videoPlaybackUstreamerConfig = stringValue(
        ustreamerRequestConfig?.videoPlaybackUstreamerConfig,
      );
      const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats)
        ? streamingData.adaptiveFormats
        : [];
      const directAudioCandidates = adaptiveFormats.filter(isRecord).flatMap((format) => {
        const url = stringValue(format.url);
        const mimeType = stringValue(format.mimeType);
        if (!url || !mimeType?.toLowerCase().startsWith("audio/")) return [];
        return [
          {
            url,
            mimeType,
            bitrate: numberValue(format.bitrate) ?? 0,
            contentLength: numberValue(format.contentLength),
          },
        ];
      });
      directAudioCandidates.sort((left, right) => {
        const mimeRank = (mimeType: string) =>
          mimeType.toLowerCase().startsWith("audio/mp4")
            ? 0
            : mimeType.toLowerCase().startsWith("audio/webm")
              ? 1
              : 2;
        return mimeRank(left.mimeType) - mimeRank(right.mimeType) || right.bitrate - left.bitrate;
      });
      const directAudio = directAudioCandidates[0] ?? null;
      const formats = adaptiveFormats.filter(isRecord).flatMap((format) => {
        const itag = numberValue(format.itag);
        const mimeType = stringValue(format.mimeType);
        const bitrate = numberValue(format.bitrate);
        if (itag === null || !mimeType || bitrate === null) return [];
        return [
          {
            itag,
            mimeType,
            bitrate,
            ...(numberValue(format.averageBitrate) !== null
              ? { averageBitrate: numberValue(format.averageBitrate) ?? undefined }
              : {}),
            ...(stringValue(format.approxDurationMs)
              ? { approxDurationMs: stringValue(format.approxDurationMs) ?? undefined }
              : {}),
            ...(stringValue(format.contentLength)
              ? { contentLength: stringValue(format.contentLength) ?? undefined }
              : {}),
            ...(stringValue(format.lastModified)
              ? { lastModified: stringValue(format.lastModified) ?? undefined }
              : {}),
            ...(stringValue(format.xtags) ? { xtags: stringValue(format.xtags) ?? undefined } : {}),
            ...(stringValue(format.audioQuality)
              ? { audioQuality: stringValue(format.audioQuality) ?? undefined }
              : {}),
            ...(isRecord(format.audioTrack) && stringValue(format.audioTrack.id)
              ? { audioTrackId: stringValue(format.audioTrack.id) ?? undefined }
              : {}),
          },
        ];
      });
      const details = player && isRecord(player.videoDetails) ? player.videoDetails : null;
      const durationSeconds = numberValue(details?.lengthSeconds);

      return {
        url: location.href,
        videoId: activeVideoId,
        title: stringValue(details?.title),
        durationSeconds,
        apiKey,
        visitorData,
        directAudio: directAudio
          ? {
              url: directAudio.url,
              mimeType: directAudio.mimeType,
              contentLength: directAudio.contentLength,
              resolver: "player",
            }
          : null,
        sabr:
          serverAbrStreamingUrl && videoPlaybackUstreamerConfig && formats.length > 0
            ? {
                serverAbrStreamingUrl,
                videoPlaybackUstreamerConfig,
                clientName,
                clientVersion,
                formats,
              }
            : null,
      };
    },
  });
  const context = result?.result ?? null;
  if (!context) return null;
  const directAudio =
    context.directAudio ?? (await resolveYoutubeDirectAudioInTab(tabId, context).catch(() => null));
  return { ...context, directAudio };
}

async function resolveYoutubeDirectAudioInTab(
  tabId: number,
  context: BrowserYoutubeMediaContext,
): Promise<BrowserYoutubeMediaContext["directAudio"]> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [
      {
        apiKey: context.apiKey,
        originalUrl: context.url,
        videoId: context.videoId,
        visitorData: context.visitorData,
      },
    ],
    func: async ({
      apiKey,
      originalUrl,
      videoId,
      visitorData,
    }: {
      apiKey: string;
      originalUrl: string;
      videoId: string;
      visitorData: string | null;
    }) => {
      const client: Record<string, unknown> = {
        clientName: "ANDROID_VR",
        clientVersion: "1.65.10",
        deviceMake: "Oculus",
        deviceModel: "Quest 3",
        androidSdkVersion: 32,
        osName: "Android",
        osVersion: "12L",
        userAgent:
          "com.google.android.youtube/1.65.10 (Linux; U; Android 12L; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip",
        originalUrl,
        hl: "en",
        gl: "US",
      };
      if (visitorData) client.visitorData = visitorData;
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Youtube-Client-Name": "28",
        "X-Youtube-Client-Version": "1.65.10",
      };
      if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;

      const response = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          context: { client },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });
      if (!response.ok) throw new Error(`YouTube player request failed (${response.status}).`);
      const payload = (await response.json()) as {
        playabilityStatus?: { status?: string };
        streamingData?: {
          adaptiveFormats?: Array<{
            url?: string;
            mimeType?: string;
            bitrate?: number;
            contentLength?: string;
          }>;
        };
      };
      if (payload.playabilityStatus?.status !== "OK") {
        throw new Error("YouTube player did not return playable media.");
      }
      const formats = (payload.streamingData?.adaptiveFormats ?? [])
        .filter(
          (format) =>
            typeof format.url === "string" &&
            typeof format.mimeType === "string" &&
            format.mimeType.startsWith("audio/"),
        )
        .sort((left, right) => {
          const mimeRank = (mimeType?: string) =>
            mimeType?.startsWith("audio/mp4") ? 0 : mimeType?.startsWith("audio/webm") ? 1 : 2;
          return (
            mimeRank(left.mimeType) - mimeRank(right.mimeType) ||
            (right.bitrate ?? 0) - (left.bitrate ?? 0)
          );
        });
      const selected = formats[0];
      if (!selected?.url || !selected.mimeType) {
        throw new Error("YouTube player returned no direct audio format.");
      }
      const contentLength = Number(selected.contentLength);
      return {
        url: selected.url,
        mimeType: selected.mimeType,
        contentLength:
          Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null,
        resolver: "android-vr" as const,
      };
    },
  });
  return result?.result ?? null;
}

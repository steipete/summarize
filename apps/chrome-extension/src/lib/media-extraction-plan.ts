import { isYouTubeVideoUrl, shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import { parseBilibiliPageVideo } from "./bilibili-page-transcript";

export type MediaInputMode = "page" | "video";

export function planMediaExtraction({
  url,
  requestedInputMode,
}: {
  url: string;
  requestedInputMode?: MediaInputMode | null;
}) {
  const isYouTubeVideo = isYouTubeVideoUrl(url);
  const isBilibiliVideo = parseBilibiliPageVideo(url) !== null;
  const prefersUrlMode = shouldPreferUrlMode(url) || isBilibiliVideo;
  const inputMode = requestedInputMode ?? (prefersUrlMode ? "video" : null);

  return {
    contentScriptInputMode: prefersUrlMode
      ? (requestedInputMode ?? "video")
      : (requestedInputMode ?? undefined),
    directYouTubeTranscript: isYouTubeVideo && requestedInputMode !== "page" && prefersUrlMode,
    directBilibiliTranscript: isBilibiliVideo && requestedInputMode !== "page",
    inputMode,
    isYouTubeVideo,
    localTranscriptKind: isYouTubeVideo
      ? ("youtube" as const)
      : isBilibiliVideo && requestedInputMode === "page"
        ? null
        : requestedInputMode === "video" || prefersUrlMode
          ? ("media" as const)
          : null,
    prefersUrlMode,
  };
}

import type { parseBilibiliVideoUrl } from "../../url.js";
import type { ProviderResult } from "../types.js";
import { fetchDirectMediaTranscript } from "./generic-direct-media.js";

export async function fetchBilibiliTranscript({
  video,
  ...request
}: Pick<
  Parameters<typeof fetchDirectMediaTranscript>[0],
  "options" | "transcription" | "notes" | "attemptedProviders"
> & { video: NonNullable<ReturnType<typeof parseBilibiliVideoUrl>> }): Promise<ProviderResult> {
  const env = request.options.env ?? request.transcription.env ?? process.env;
  const cookies = (
    env.SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER ??
    env.YT_DLP_COOKIES_FROM_BROWSER ??
    ""
  ).trim();
  // Bilibili's overseas media CDN can reject non-ranged requests with HTTP 567.
  const result = await fetchDirectMediaTranscript({
    ...request,
    url: video.url,
    kind: "video",
    extraArgs: ["--http-chunk-size", "1M", ...(cookies ? ["--cookies-from-browser", cookies] : [])],
  });
  return {
    ...(result ?? {
      text: null,
      source: null,
      attemptedProviders: request.attemptedProviders,
      notes: request.notes.length > 0 ? request.notes.join("; ") : null,
    }),
    metadata: {
      ...result?.metadata,
      provider: "generic",
      kind: "video",
      site: "bilibili",
      videoId: video.videoId,
      part: video.part,
      videoUrl: video.url,
      ...(!result ? { reason: "transcript_unavailable" } : {}),
    },
  };
}

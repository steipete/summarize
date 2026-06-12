import {
  formatYoutubeCaptionLines,
  normalizeYoutubeCaptionText,
  parseTimestampStringToMs,
  rankYoutubeCaptionTracks,
  resolveYoutubeCaptionTrack,
} from "@steipete/summarize-core/content/youtube-captions";

export type BrowserYouTubeTranscript =
  | {
      ok: true;
      url: string;
      text: string;
      transcriptTimedText: string;
      truncated: boolean;
      durationSeconds: number | null;
    }
  | { ok: false; error: string };

export type BrowserYouTubeCaptionSource = {
  url: string;
  durationSeconds: number | null;
  tracks: Array<{
    baseUrl: string;
    languageCode: string;
    kind: string;
    label: string;
  }>;
};

export type BrowserYouTubeTranscriptPanel = {
  url: string;
  lines: Array<{ timestamp: string | null; text: string }>;
};

// Keep this function self-contained: Chrome serializes it for MAIN-world injection.
export function readYouTubePageCaptionSource(): BrowserYouTubeCaptionSource {
  type CaptionTrack = {
    baseUrl?: unknown;
    languageCode?: unknown;
    kind?: unknown;
    name?: { simpleText?: unknown; runs?: Array<{ text?: unknown }> };
  };
  type PlayerResponse = {
    captions?: {
      playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
    };
    videoDetails?: { lengthSeconds?: unknown; videoId?: unknown };
  };

  const activeVideoId = (() => {
    try {
      const url = new URL(location.href);
      return url.searchParams.get("v") ?? url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  })();
  const asObject = (value: unknown) =>
    value && typeof value === "object" ? (value as PlayerResponse) : undefined;
  const hasCaptionTracks = (player: PlayerResponse | undefined) =>
    Boolean(player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
  const findBalancedJsonAfter = (source: string, marker: string) => {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = source.indexOf("{", markerIndex + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escape) escape = false;
        else if (char === "\\") escape = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return null;
  };
  const isCurrentPlayer = (player: PlayerResponse | undefined, requireVideoId: boolean) => {
    if (!player || !activeVideoId) return Boolean(player);
    const playerVideoId = player.videoDetails?.videoId;
    if (typeof playerVideoId === "string") return playerVideoId === activeVideoId;
    return !requireVideoId;
  };
  const globalData = globalThis as typeof globalThis & {
    ytInitialPlayerResponse?: unknown;
  };
  const flexy = document.querySelector("ytd-watch-flexy") as
    | (Element & { playerData?: unknown; playerResponse?: unknown })
    | null;
  const moviePlayer = document.querySelector("#movie_player") as
    | (Element & { getPlayerResponse?: () => unknown })
    | null;
  const playerCandidates = [
    asObject(moviePlayer?.getPlayerResponse?.()),
    asObject(flexy?.playerData),
    asObject(flexy?.playerResponse),
    asObject(globalData.ytInitialPlayerResponse),
  ].filter((candidate): candidate is PlayerResponse => Boolean(candidate));
  let player = activeVideoId
    ? (playerCandidates.find((candidate) => candidate.videoDetails?.videoId === activeVideoId) ??
      playerCandidates.find(
        (candidate) =>
          typeof candidate.videoDetails?.videoId !== "string" && hasCaptionTracks(candidate),
      ))
    : (playerCandidates.find(hasCaptionTracks) ?? playerCandidates[0]);
  if (!player) {
    for (const script of Array.from(document.querySelectorAll("script"))) {
      const text = script.textContent ?? "";
      if (!text.includes("ytInitialPlayerResponse")) continue;
      const raw = findBalancedJsonAfter(text, "ytInitialPlayerResponse");
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as PlayerResponse;
        if (isCurrentPlayer(parsed, true)) {
          player = parsed;
          break;
        }
      } catch {
        // Keep scanning; YouTube has several script shapes.
      }
    }
  }

  const duration =
    typeof player?.videoDetails?.lengthSeconds === "string"
      ? Number(player.videoDetails.lengthSeconds)
      : null;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return {
    url: location.href,
    durationSeconds: Number.isFinite(duration) ? duration : null,
    tracks: tracks.flatMap((track) => {
      if (typeof track.baseUrl !== "string") return [];
      const label =
        typeof track.name?.simpleText === "string"
          ? track.name.simpleText
          : Array.isArray(track.name?.runs)
            ? track.name.runs
                .map((run) => (typeof run.text === "string" ? run.text : ""))
                .join("")
                .trim()
            : "";
      return [
        {
          baseUrl: track.baseUrl,
          languageCode:
            typeof track.languageCode === "string" ? track.languageCode.toLowerCase() : "",
          kind: typeof track.kind === "string" ? track.kind.toLowerCase() : "",
          label,
        },
      ];
    }),
  };
}

// Keep this function self-contained: Chrome serializes it for MAIN-world injection.
export async function fetchYouTubeCaptionText(
  url: string,
  expectedPageUrl: string | null = null,
): Promise<string | null> {
  const pageIdentity = (value: string) => {
    try {
      const pageUrl = new URL(value);
      const videoId =
        pageUrl.searchParams.get("v") ??
        pageUrl.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] ??
        null;
      return videoId ? `youtube:${videoId}` : pageUrl.href;
    } catch {
      return value;
    }
  };
  const expectedIdentity = expectedPageUrl ? pageIdentity(expectedPageUrl) : null;
  const isExpectedPage = () =>
    expectedIdentity == null || pageIdentity(location.href) === expectedIdentity;
  if (!isExpectedPage()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !isExpectedPage()) return null;
    const raw = await response.text();
    return isExpectedPage() && raw.trim() ? raw : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Keep this function self-contained: Chrome serializes it for MAIN-world injection.
export async function readYouTubeTranscriptPanel(
  expectedPageUrl: string | null = null,
): Promise<BrowserYouTubeTranscriptPanel | null> {
  const pageIdentity = (value: string) => {
    try {
      const pageUrl = new URL(value);
      const videoId =
        pageUrl.searchParams.get("v") ??
        pageUrl.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1] ??
        null;
      return videoId ? `youtube:${videoId}` : pageUrl.href;
    } catch {
      return value;
    }
  };
  const expectedIdentity = expectedPageUrl ? pageIdentity(expectedPageUrl) : null;
  const isExpectedPage = () =>
    expectedIdentity == null || pageIdentity(location.href) === expectedIdentity;
  const normalize = (text: string) =>
    text
      .replace(/\s+/g, " ")
      .replace(/&nbsp;/g, " ")
      .trim();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const parsePanel = () => {
    const segments = Array.from(
      document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model"),
    );
    return segments
      .map((segment) => {
        const textElement = segment.querySelector(
          "#segment-text, .segment-text, .ytAttributedStringHost[role='text'], span[role='text']",
        );
        const timestampElement = segment.querySelector(
          "#timestamp, .segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp",
        );
        const text = normalize(textElement?.textContent ?? "");
        const timestamp = normalize(timestampElement?.textContent ?? "");
        return {
          timestamp: /^\d{1,2}:\d{2}(?::\d{2})?$/.test(timestamp) ? timestamp : null,
          text,
        };
      })
      .filter((line) => line.text.length > 0);
  };
  const buttons = () =>
    Array.from(document.querySelectorAll("button, tp-yt-paper-button, ytd-button-renderer"));
  const scrollBefore = { x: globalThis.scrollX ?? 0, y: globalThis.scrollY ?? 0 };
  try {
    if (!isExpectedPage()) return null;
    document.querySelector("ytd-watch-metadata")?.scrollIntoView({ block: "center" });
    await delay(120);
    if (!isExpectedPage()) return null;
    const expand = buttons().find((element) =>
      /\bmore\b/i.test(normalize(element.textContent ?? "")),
    ) as HTMLElement | undefined;
    expand?.click();
    await delay(250);
    if (!isExpectedPage()) return null;
    const transcriptButton = (document.querySelector(
      "ytd-video-description-transcript-section-renderer button",
    ) ??
      buttons().find((element) =>
        /show transcript/i.test(normalize(element.textContent ?? "")),
      )) as HTMLElement | undefined;
    if (!transcriptButton) return null;
    transcriptButton.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(200);
      if (!isExpectedPage()) return null;
      const lines = parsePanel();
      if (lines.length > 0) return { url: location.href, lines };
    }
    return null;
  } finally {
    if (isExpectedPage()) {
      globalThis.scrollTo?.(scrollBefore.x, scrollBefore.y);
    }
  }
}

function clampText(text: string, maxLength: number) {
  if (text.length <= maxLength) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxLength - 24))}\n\n[TRUNCATED]`,
    truncated: true,
  };
}

function buildTranscriptResult({
  source,
  raw,
  limit,
}: {
  source: BrowserYouTubeCaptionSource;
  raw: string;
  limit: number;
}): BrowserYouTubeTranscript {
  const normalized = raw.trim();
  if (!normalized) return { ok: false, error: "No YouTube caption transcript found." };
  const clamped = clampText(`Transcript:\n${normalized}`, limit);
  const timed = clampText(normalized, limit);
  return {
    ok: true,
    url: source.url,
    text: clamped.text,
    transcriptTimedText: timed.text,
    truncated: clamped.truncated,
    durationSeconds: source.durationSeconds,
  };
}

export async function resolveYouTubePageTranscript({
  source,
  limit,
  loadCaptionText,
  loadPanel = null,
}: {
  source: BrowserYouTubeCaptionSource;
  limit: number;
  loadCaptionText: (url: string) => Promise<string | null>;
  loadPanel?: (() => Promise<BrowserYouTubeTranscriptPanel | null>) | null;
}): Promise<BrowserYouTubeTranscript> {
  const tracks = rankYoutubeCaptionTracks({
    captionTracks: source.tracks,
    priority: "english-first",
  });
  for (const track of tracks) {
    const transcript = await resolveYoutubeCaptionTrack(track.baseUrl, loadCaptionText);
    if (!transcript) continue;
    return buildTranscriptResult({
      source,
      raw: formatYoutubeCaptionLines(transcript.lines),
      limit,
    });
  }

  const panel = await loadPanel?.();
  if (panel?.lines.length) {
    return buildTranscriptResult({
      source: { ...source, url: panel.url },
      raw: formatYoutubeCaptionLines(
        panel.lines.map((line) => ({
          startMs: line.timestamp ? parseTimestampStringToMs(line.timestamp) : null,
          endMs: null,
          text: normalizeYoutubeCaptionText(line.text),
        })),
      ),
      limit,
    });
  }
  return { ok: false, error: "No YouTube caption transcript found." };
}

export async function extractYouTubePageTranscript(
  limit: number,
  allowPanelFallback = true,
): Promise<BrowserYouTubeTranscript> {
  const source = readYouTubePageCaptionSource();
  return resolveYouTubePageTranscript({
    source,
    limit,
    loadCaptionText: (url) => fetchYouTubeCaptionText(url, source.url),
    loadPanel: allowPanelFallback ? () => readYouTubeTranscriptPanel(source.url) : null,
  });
}

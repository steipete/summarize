type BrowserYouTubeTranscript =
  | {
      ok: true;
      url: string;
      text: string;
      transcriptTimedText: string;
      truncated: boolean;
      durationSeconds: number | null;
    }
  | { ok: false; error: string };

export async function extractYouTubeTranscriptInTab(
  tabId: number,
  maxChars: number,
): Promise<BrowserYouTubeTranscript> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [maxChars],
      func: async (limit: number): Promise<BrowserYouTubeTranscript> => {
        type CaptionTrack = {
          baseUrl?: unknown;
          languageCode?: unknown;
          kind?: unknown;
          name?: { simpleText?: unknown; runs?: Array<{ text?: unknown }> };
        };

        const clampText = (text: string, maxLength: number) => {
          if (text.length <= maxLength) return { text, truncated: false };
          return {
            text: `${text.slice(0, Math.max(0, maxLength - 24))}\n\n[TRUNCATED]`,
            truncated: true,
          };
        };
        const labelForTrack = (track: CaptionTrack) => {
          if (typeof track.name?.simpleText === "string") return track.name.simpleText;
          if (Array.isArray(track.name?.runs)) {
            return track.name.runs
              .map((run) => (typeof run.text === "string" ? run.text : ""))
              .join("")
              .trim();
          }
          return "";
        };
        const sortCaptionTracks = (tracks: CaptionTrack[]) => {
          const score = (track: CaptionTrack) => {
            const language =
              typeof track.languageCode === "string" ? track.languageCode.toLowerCase() : "";
            const label = labelForTrack(track).toLowerCase();
            const isAutomatic = track.kind === "asr" || label.includes("auto-generated");
            return [
              language === "en" || language.startsWith("en-") ? 0 : 10,
              isAutomatic ? 1 : 0,
              label.includes("english") ? 0 : 1,
            ].join(":");
          };
          return tracks
            .filter((track) => typeof track.baseUrl === "string")
            .sort((left, right) => score(left).localeCompare(score(right)));
        };
        const formatTimestamp = (ms: number) => {
          const totalSeconds = Math.max(0, Math.floor(ms / 1000));
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const seconds = totalSeconds % 60;
          const two = (value: number) => String(value).padStart(2, "0");
          return hours > 0
            ? `${hours}:${two(minutes)}:${two(seconds)}`
            : `${minutes}:${two(seconds)}`;
        };
        const normalizeCaptionText = (text: string) =>
          text
            .replace(/\s+/g, " ")
            .replace(/&nbsp;/g, " ")
            .trim();
        const parseJson3 = (raw: string) => {
          const data = JSON.parse(raw) as {
            events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
          };
          return (data.events ?? [])
            .map((event) => ({
              startMs: typeof event.tStartMs === "number" ? event.tStartMs : null,
              text: normalizeCaptionText((event.segs ?? []).map((seg) => seg.utf8 ?? "").join("")),
            }))
            .filter((line) => line.text.length > 0);
        };
        const parseXml = (raw: string) =>
          Array.from(new DOMParser().parseFromString(raw, "text/xml").querySelectorAll("text"))
            .map((node) => {
              const start = Number(node.getAttribute("start"));
              return {
                startMs: Number.isFinite(start) ? Math.round(start * 1000) : null,
                text: normalizeCaptionText(node.textContent ?? ""),
              };
            })
            .filter((line) => line.text.length > 0);
        const parseVtt = (raw: string) => {
          const lines: Array<{ startMs: number | null; text: string }> = [];
          let pendingStart: number | null = null;
          let pendingText: string[] = [];
          const flush = () => {
            const text = normalizeCaptionText(pendingText.join(" "));
            if (text) lines.push({ startMs: pendingStart, text });
            pendingStart = null;
            pendingText = [];
          };
          for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) {
              flush();
              continue;
            }
            const timing = trimmed.match(/^(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s+-->/);
            if (timing) {
              flush();
              const parts = trimmed.split(/\s+-->\s+/)[0].split(":");
              const secondsPart = parts.pop() ?? "0";
              const minutes = Number(parts.pop() ?? "0");
              const hours = Number(parts.pop() ?? "0");
              const seconds = Number(secondsPart);
              pendingStart = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
              continue;
            }
            if (trimmed === "WEBVTT" || /^\d+$/.test(trimmed)) continue;
            pendingText.push(trimmed);
          }
          flush();
          return lines;
        };
        const captionUrls = (baseUrl: string) => {
          const withFormat = (format: string) => {
            const url = new URL(baseUrl);
            url.searchParams.set("fmt", format);
            return url.toString();
          };
          return Array.from(new Set([withFormat("json3"), baseUrl, withFormat("vtt")]));
        };
        const fetchWithTimeout = async (url: string, timeoutMs = 5000) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await fetch(url, { signal: controller.signal });
          } finally {
            clearTimeout(timer);
          }
        };
        const fetchLines = async (track: CaptionTrack) => {
          if (typeof track.baseUrl !== "string") return [];
          for (const url of captionUrls(track.baseUrl)) {
            try {
              const res = await fetchWithTimeout(url);
              if (!res.ok) continue;
              const raw = (await res.text()).trim();
              if (!raw) continue;
              const lines = raw.startsWith("{")
                ? parseJson3(raw)
                : raw.startsWith("WEBVTT")
                  ? parseVtt(raw)
                  : parseXml(raw);
              if (lines.length > 0) return lines;
            } catch {
              // Try the next track/format.
            }
          }
          return [];
        };
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const parseTranscriptPanel = () => {
          const segments = Array.from(
            document.querySelectorAll(
              "ytd-transcript-segment-renderer, transcript-segment-view-model",
            ),
          );
          return segments
            .map((segment) => {
              const textEl = segment.querySelector(
                "#segment-text, .segment-text, .ytAttributedStringHost[role='text'], span[role='text']",
              );
              const timestampEl = segment.querySelector(
                "#timestamp, .segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp",
              );
              const text = normalizeCaptionText(textEl?.textContent ?? "");
              const timestamp = normalizeCaptionText(timestampEl?.textContent ?? "");
              const timestampMatch = timestamp.match(/^\d{1,2}:\d{2}(?::\d{2})?$/);
              return {
                startMs: null,
                timestamp: timestampMatch ? timestamp : null,
                text,
              };
            })
            .filter((line) => line.text.length > 0);
        };
        const clickTranscriptButton = async () => {
          document.querySelector("ytd-watch-metadata")?.scrollIntoView({ block: "center" });
          await delay(120);
          const buttons = () =>
            Array.from(
              document.querySelectorAll("button, tp-yt-paper-button, ytd-button-renderer"),
            );
          const expand = buttons().find((el) =>
            /\bmore\b/i.test(normalizeCaptionText(el.textContent ?? "")),
          ) as HTMLElement | undefined;
          expand?.click();
          await delay(250);
          const transcriptButton = (document.querySelector(
            "ytd-video-description-transcript-section-renderer button",
          ) ??
            buttons().find((el) =>
              /show transcript/i.test(normalizeCaptionText(el.textContent ?? "")),
            )) as HTMLElement | undefined;
          if (!transcriptButton) return false;
          transcriptButton?.click();
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await delay(200);
            if (parseTranscriptPanel().length > 0) return true;
          }
          return false;
        };

        const globalData = globalThis as typeof globalThis & {
          ytInitialPlayerResponse?: unknown;
        };
        const flexy = document.querySelector("ytd-watch-flexy") as
          | (Element & { playerData?: unknown; playerResponse?: unknown })
          | null;
        type PlayerResponse = {
          captions?: {
            playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
          };
          videoDetails?: { lengthSeconds?: unknown; videoId?: unknown };
        };
        const activeVideoId = (() => {
          try {
            const url = new URL(location.href);
            const watchId = url.searchParams.get("v");
            if (watchId) return watchId;
            const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
            return shortsMatch?.[1] ?? null;
          } catch {
            return null;
          }
        })();
        const asObject = (value: unknown) =>
          value && typeof value === "object" ? (value as PlayerResponse) : undefined;
        const initialPlayer = asObject(globalData.ytInitialPlayerResponse);
        const playerCandidates = [
          asObject(flexy?.playerData),
          asObject(flexy?.playerResponse),
          initialPlayer,
        ].filter((candidate): candidate is PlayerResponse => Boolean(candidate));
        const hasCaptionTracks = (playerResponse: PlayerResponse | undefined) =>
          Boolean(playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
        const player = activeVideoId
          ? (playerCandidates.find(
              (candidate) => candidate.videoDetails?.videoId === activeVideoId,
            ) ??
            playerCandidates.find(
              (candidate) =>
                typeof candidate.videoDetails?.videoId !== "string" && hasCaptionTracks(candidate),
            ))
          : (playerCandidates.find(hasCaptionTracks) ?? playerCandidates[0]);
        const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
        for (const track of sortCaptionTracks(tracks)) {
          const lines = await fetchLines(track);
          if (lines.length === 0) continue;
          const raw = lines
            .map((line) =>
              typeof line.startMs === "number"
                ? `[${formatTimestamp(line.startMs)}] ${line.text}`
                : line.text,
            )
            .join("\n")
            .trim();
          const clamped = clampText(`Transcript:\n${raw}`, limit);
          const timed = clampText(raw, limit);
          const duration =
            typeof player?.videoDetails?.lengthSeconds === "string"
              ? Number(player.videoDetails.lengthSeconds)
              : null;
          return {
            ok: true,
            url: location.href,
            text: clamped.text,
            transcriptTimedText: timed.text,
            truncated: clamped.truncated,
            durationSeconds: Number.isFinite(duration) ? duration : null,
          };
        }
        const pageWindow = globalThis as typeof globalThis & {
          scrollX?: number;
          scrollY?: number;
          scrollTo?: (x: number, y: number) => void;
        };
        const scrollBeforeFallback = {
          x: pageWindow.scrollX ?? 0,
          y: pageWindow.scrollY ?? 0,
        };
        try {
          if (await clickTranscriptButton()) {
            const panelLines = parseTranscriptPanel();
            if (panelLines.length > 0) {
              const raw = panelLines
                .map((line) => (line.timestamp ? `[${line.timestamp}] ${line.text}` : line.text))
                .join("\n")
                .trim();
              const clamped = clampText(`Transcript:\n${raw}`, limit);
              const timed = clampText(raw, limit);
              const duration =
                typeof player?.videoDetails?.lengthSeconds === "string"
                  ? Number(player.videoDetails.lengthSeconds)
                  : null;
              return {
                ok: true,
                url: location.href,
                text: clamped.text,
                transcriptTimedText: timed.text,
                truncated: clamped.truncated,
                durationSeconds: Number.isFinite(duration) ? duration : null,
              };
            }
          }
        } finally {
          pageWindow.scrollTo?.(scrollBeforeFallback.x, scrollBeforeFallback.y);
        }
        return { ok: false, error: "No YouTube caption transcript found." };
      },
    });
    return result.result ?? { ok: false, error: "No transcript result returned." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

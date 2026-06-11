import { resolveYoutubeAudioWithAndroidVr } from "@steipete/summarize-core/content/youtube";
import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import type { BrowserYoutubeMediaContext } from "../background/youtube-media";
import type { CapturedYoutubeSabrRequest } from "../background/youtube-sabr-capture";

const MAX_BROWSER_AUDIO_BYTES = 128 * 1024 * 1024;
const RANGE_ATTEMPTS = 3;

export type DownloadedYoutubeAudio = {
  bytes: Uint8Array;
  mimeType: string;
  mediaSource: "sabr" | "player" | "android-vr";
};

export type ResolvedYoutubeDirectAudio = {
  contentLength: number | null;
  mediaSource: "player" | "android-vr";
  mimeType: string;
  url: string;
};

export async function downloadYoutubeAudio({
  context,
  capturedSabr,
  ignoreContextDirect = false,
}: {
  context: BrowserYoutubeMediaContext;
  capturedSabr: CapturedYoutubeSabrRequest | null;
  ignoreContextDirect?: boolean;
}): Promise<DownloadedYoutubeAudio> {
  let directError: unknown;
  try {
    return await downloadViaDirectAudio(context, ignoreContextDirect);
  } catch (error) {
    directError = error;
  }

  if (context.sabr && capturedSabr) {
    try {
      return await downloadViaSabr(context, capturedSabr);
    } catch (sabrError) {
      throw new Error(
        `Direct YouTube audio failed: ${errorMessage(directError)} SABR failed: ${errorMessage(sabrError)}`,
      );
    }
  }

  throw directError ?? new Error("Captured YouTube SABR media is unavailable.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveYoutubeDirectAudio(
  context: BrowserYoutubeMediaContext,
  { ignoreContextDirect = false }: { ignoreContextDirect?: boolean } = {},
): Promise<ResolvedYoutubeDirectAudio> {
  const media =
    (!ignoreContextDirect ? context.directAudio : null) ??
    (await resolveYoutubeAudioWithAndroidVr({
      fetchImpl: fetch,
      videoId: context.videoId,
      apiKey: context.apiKey,
      visitorData: context.visitorData,
      originalUrl: context.url,
      preferredMimeTypes: ["audio/mp4", "audio/webm"],
    }));
  return {
    contentLength: media.contentLength,
    mediaSource:
      !ignoreContextDirect && context.directAudio ? context.directAudio.resolver : "android-vr",
    mimeType: media.mimeType,
    url: media.url,
  };
}

async function downloadViaDirectAudio(
  context: BrowserYoutubeMediaContext,
  ignoreContextDirect: boolean,
): Promise<DownloadedYoutubeAudio> {
  const media = await resolveYoutubeDirectAudio(context, { ignoreContextDirect });
  let bytes: Uint8Array;
  if (media.contentLength && media.contentLength > 0) {
    bytes = await downloadYoutubeBytesWithRanges({
      url: media.url,
      contentLength: media.contentLength,
    });
  } else {
    const response = await fetch(media.url);
    if (!response.ok) throw new Error(`YouTube audio download failed (${response.status}).`);
    bytes = await readResponseWithLimit(response, MAX_BROWSER_AUDIO_BYTES);
  }
  return {
    bytes,
    mimeType: media.mimeType,
    mediaSource: media.mediaSource,
  };
}

export async function downloadYoutubeBytesWithRanges({
  url,
  contentLength,
  fetchImpl = fetch,
}: {
  url: string;
  contentLength: number;
  fetchImpl?: typeof fetch;
}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new Error("YouTube audio content length is invalid.");
  }
  if (contentLength > MAX_BROWSER_AUDIO_BYTES) {
    throw new Error("YouTube audio is too large for local browser transcription.");
  }

  return await downloadYoutubeRange({
    url,
    start: 0,
    end: contentLength - 1,
    fetchImpl,
  });
}

async function downloadYoutubeRange({
  url,
  start,
  end,
  fetchImpl,
}: {
  url: string;
  start: number;
  end: number;
  fetchImpl: typeof fetch;
}): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RANGE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        credentials: "omit",
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status !== 206 && !(response.status === 200 && start === 0)) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const expectedLength = end - start + 1;
      if (bytes.byteLength !== expectedLength) {
        throw new Error(`expected ${expectedLength} bytes, received ${bytes.byteLength}`);
      }
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < RANGE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
      }
    }
  }
  throw new Error(
    `YouTube ranged audio download failed for bytes ${start}-${end}: ${errorMessage(lastError)}`,
  );
}

async function downloadViaSabr(
  context: BrowserYoutubeMediaContext,
  captured: CapturedYoutubeSabrRequest,
): Promise<DownloadedYoutubeAudio> {
  const sabr = context.sabr;
  if (!sabr) throw new Error("SABR player configuration is unavailable.");
  const audioFormat = sabr.formats
    .filter((format) => format.mimeType.toLowerCase().startsWith("audio/"))
    .sort((left, right) => right.bitrate - left.bitrate)[0];
  if (!audioFormat) throw new Error("The active YouTube player has no SABR audio format.");

  const formats = sabr.formats.map((format) =>
    buildSabrFormat({
      itag: format.itag,
      lastModified: format.lastModified,
      xtags: format.xtags,
      mimeType: format.mimeType,
      audioQuality: format.audioQuality,
      bitrate: format.bitrate,
      averageBitrate: format.averageBitrate,
      audioTrackId: format.audioTrackId,
      approxDurationMs: format.approxDurationMs,
      contentLength: format.contentLength,
      isDrc: false,
    }),
  );
  const selected = formats.find((format) => format.itag === audioFormat.itag);
  if (!selected) throw new Error("The selected SABR audio format is unavailable.");

  const stream = new SabrStream({
    fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
    serverAbrStreamingUrl: captured.url || sabr.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: sabr.videoPlaybackUstreamerConfig,
    clientInfo: {
      clientName: sabr.clientName,
      clientVersion: sabr.clientVersion,
    },
    poToken: captured.poToken ?? undefined,
    formats,
    durationMs: Math.round(
      Number(audioFormat.approxDurationMs) || (context.durationSeconds ?? 0) * 1000,
    ),
  });
  try {
    const { audioStream } = await stream.start({
      audioFormat: selected,
      enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
      maxRetries: 2,
      stallDetectionMs: 20_000,
    });
    return {
      bytes: await readStreamWithLimit(audioStream, MAX_BROWSER_AUDIO_BYTES),
      mimeType: audioFormat.mimeType,
      mediaSource: "sabr",
    };
  } catch (error) {
    stream.abort();
    throw error;
  }
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("YouTube audio is too large for local browser transcription.");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error("YouTube audio is too large for local browser transcription.");
    }
    return bytes;
  }
  return await readStreamWithLimit(response.body, maxBytes);
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("YouTube audio is too large for local browser transcription.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

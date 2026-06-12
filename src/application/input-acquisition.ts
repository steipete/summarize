import path from "node:path";
import { isDirectMediaExtension, isDirectMediaUrl } from "@steipete/summarize-core/content/url";
import {
  classifyUrl,
  type AssetAttachment,
  loadLocalAsset,
  loadRemoteAsset,
  shouldProbeUnknownAssetUrl,
} from "../content/asset.js";
import { assertAssetMediaTypeSupported } from "../run/attachments.js";

export type AcquiredAssetInput = {
  kind: "resolved-asset" | "resolved-media";
  sourceKind: "file" | "asset-url";
  sourceLabel: string;
  attachment: AssetAttachment;
};

export type UrlAssetRoute = "asset" | "media" | "none";

function normalizePathForExtension(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

export function isTranscribableAssetPath(value: string): boolean {
  if (isDirectMediaUrl(value)) return true;
  const ext = path.extname(normalizePathForExtension(value));
  return isDirectMediaExtension(ext);
}

export function isPdfAssetPath(value: string): boolean {
  return path.extname(normalizePathForExtension(value)).toLowerCase() === ".pdf";
}

function isTranscribableMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  return normalized.startsWith("audio/") || normalized.startsWith("video/");
}

function createMediaInput({
  sourceKind,
  sourceLabel,
  filename,
}: {
  sourceKind: "file" | "asset-url";
  sourceLabel: string;
  filename: string;
}): AcquiredAssetInput {
  return {
    kind: "resolved-media",
    sourceKind,
    sourceLabel,
    attachment: {
      kind: "file",
      filename,
      mediaType: "audio/mpeg",
      bytes: new Uint8Array(0),
    },
  };
}

export async function acquireLocalAssetInput({
  filePath,
  maxBytes,
}: {
  filePath: string;
  maxBytes?: number;
}): Promise<AcquiredAssetInput> {
  if (isTranscribableAssetPath(filePath)) {
    return createMediaInput({
      sourceKind: "file",
      sourceLabel: filePath,
      filename: path.basename(filePath),
    });
  }

  const loaded = await loadLocalAsset({ filePath, maxBytes });
  assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel: null });
  return {
    kind: isTranscribableMediaType(loaded.attachment.mediaType)
      ? "resolved-media"
      : "resolved-asset",
    sourceKind: "file",
    sourceLabel: loaded.sourceLabel,
    attachment: loaded.attachment,
  };
}

export async function resolveUrlAssetRoute({
  url,
  isYoutubeUrl,
  fetchImpl,
  timeoutMs,
  detectUnknownAssetUrls = true,
  assumeAsset = false,
}: {
  url: string;
  isYoutubeUrl: boolean;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  detectUnknownAssetUrls?: boolean;
  assumeAsset?: boolean;
}): Promise<UrlAssetRoute> {
  if (!url || isYoutubeUrl) return "none";
  if (isTranscribableAssetPath(url)) return "media";
  if (assumeAsset) return "asset";
  if (!detectUnknownAssetUrls && !shouldProbeUnknownAssetUrl(url)) return "none";

  const kind = await classifyUrl({ url, fetchImpl, timeoutMs });
  return kind.kind === "asset" ? "asset" : "none";
}

export function createRemoteMediaInput(url: string): AcquiredAssetInput {
  let filename = "media";
  try {
    filename = path.basename(new URL(url).pathname) || filename;
  } catch {
    // Keep the stable fallback name.
  }
  return createMediaInput({
    sourceKind: "asset-url",
    sourceLabel: url,
    filename,
  });
}

export async function acquireRemoteAssetInput({
  url,
  fetchImpl,
  timeoutMs,
}: {
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<AcquiredAssetInput | null> {
  const loaded = await (async () => {
    try {
      return await loadRemoteAsset({ url, fetchImpl, timeoutMs });
    } catch (error) {
      if (error instanceof Error && /HTML/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  })();
  if (!loaded) return null;

  assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel: null });
  return {
    kind: "resolved-asset",
    sourceKind: "asset-url",
    sourceLabel: loaded.sourceLabel,
    attachment: loaded.attachment,
  };
}

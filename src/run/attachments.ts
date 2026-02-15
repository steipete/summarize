import mime from "mime";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { loadLocalAsset } from "../content/asset.js";
import { formatBytes } from "../tty/format.js";

export type AssetAttachment = Awaited<ReturnType<typeof loadLocalAsset>>["attachment"];

export const MAX_DOCUMENT_BYTES_DEFAULT = 50 * 1024 * 1024;

export function isUnsupportedAttachmentError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: unknown; message?: unknown };
  const name = typeof err.name === "string" ? err.name : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (name.toLowerCase().includes("unsupportedfunctionality")) return true;
  if (message.toLowerCase().includes("functionality not supported")) return true;
  return false;
}

export function isTextLikeMediaType(mediaType: string): boolean {
  const mt = mediaType.toLowerCase();
  if (mt.startsWith("text/")) return true;
  // Common “text but not text/*” types we want to inline instead of attaching as a file part.
  return (
    mt === "application/json" ||
    mt === "application/xml" ||
    mt === "application/x-yaml" ||
    mt === "application/yaml" ||
    mt === "application/toml" ||
    mt === "application/rtf" ||
    mt === "application/javascript"
  );
}

function isArchiveMediaType(mediaType: string): boolean {
  const mt = mediaType.toLowerCase();
  return (
    mt === "application/zip" ||
    mt === "application/x-zip-compressed" ||
    mt === "application/x-7z-compressed" ||
    mt === "application/x-rar-compressed" ||
    mt === "application/x-tar" ||
    mt === "application/gzip"
  );
}

function attachmentByteLength(attachment: AssetAttachment) {
  return attachment.bytes.byteLength;
}

export function assertAssetMediaTypeSupported({
  attachment,
  sizeLabel,
}: {
  attachment: AssetAttachment;
  sizeLabel: string | null;
}) {
  if (!isArchiveMediaType(attachment.mediaType)) return;

  const name = attachment.filename ?? "file";
  const bytes = attachmentByteLength(attachment);
  const size = sizeLabel ?? (typeof bytes === "number" ? formatBytes(bytes) : null);
  const details = size ? `${attachment.mediaType}, ${size}` : attachment.mediaType;

  throw new Error(
    `Unsupported file type: ${name} (${details})\n` +
      `Archive formats (zip/tar/7z/rar) can’t be sent to the model.\n` +
      `Unzip and summarize a specific file instead (e.g. README.md).`,
  );
}

export function getTextContentFromAttachment(
  attachment: AssetAttachment,
): { content: string; bytes: number } | null {
  if (attachment.kind !== "file" || !isTextLikeMediaType(attachment.mediaType)) {
    return null;
  }
  return {
    content: new TextDecoder().decode(attachment.bytes),
    bytes: attachment.bytes.byteLength,
  };
}

export function getFileBytesFromAttachment(attachment: AssetAttachment): Uint8Array | null {
  if (attachment.kind !== "file") return null;
  return attachment.bytes;
}

function getAttachmentBytes(attachment: AssetAttachment): Uint8Array | null {
  return attachment.bytes;
}

export async function ensureCliAttachmentPath({
  sourceKind,
  sourceLabel,
  attachment,
}: {
  sourceKind: "file" | "asset-url";
  sourceLabel: string;
  attachment: AssetAttachment;
}): Promise<string> {
  if (sourceKind === "file") return sourceLabel;
  const bytes = getAttachmentBytes(attachment);
  if (!bytes) {
    throw new Error("CLI attachment missing bytes");
  }
  const ext =
    attachment.filename && path.extname(attachment.filename)
      ? path.extname(attachment.filename)
      : attachment.mediaType
        ? `.${mime.getExtension(attachment.mediaType) ?? "bin"}`
        : ".bin";
  const filename = attachment.filename?.trim() || `asset${ext}`;
  const dir = await fs.mkdtemp(path.join(tmpdir(), "summarize-cli-asset-"));
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

export function shouldMarkitdownConvertMediaType(mediaType: string): boolean {
  const mt = mediaType.toLowerCase();
  if (mt === "application/pdf") return true;
  if (mt === "application/rtf") return true;
  if (mt === "text/html" || mt === "application/xhtml+xml") return true;
  if (mt === "application/msword") return true;
  if (mt.startsWith("application/vnd.openxmlformats-officedocument.")) return true;
  if (mt === "application/vnd.ms-excel") return true;
  if (mt === "application/vnd.ms-powerpoint") return true;
  return false;
}

export function supportsNativeFileAttachment({
  provider,
  attachment,
}: {
  provider: "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia" | "vertex";
  attachment: { kind: "image" | "file"; mediaType: string };
}): boolean {
  if (attachment.kind !== "file") return false;
  if (provider !== "anthropic" && provider !== "openai" && provider !== "google") return false;
  return attachment.mediaType.toLowerCase() === "application/pdf";
}

export function assertProviderSupportsAttachment({
  provider,
  modelId,
  attachment,
}: {
  provider: "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia" | "vertex";
  modelId: string;
  attachment: { kind: "image" | "file"; mediaType: string };
}) {
  void provider;
  void modelId;
  void attachment;
}

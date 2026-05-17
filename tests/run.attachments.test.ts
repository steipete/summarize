import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AssetAttachment,
  assertAssetMediaTypeSupported,
  ensureCliAttachmentPath,
  getFileBytesFromAttachment,
  getTextContentFromAttachment,
  isTextLikeMediaType,
  isUnsupportedAttachmentError,
  shouldMarkitdownConvertMediaType,
  supportsNativeFileAttachment,
} from "../src/run/attachments.js";

describe("run/attachments", () => {
  it("detects unsupported attachment errors", () => {
    expect(isUnsupportedAttachmentError(null)).toBe(false);
    expect(isUnsupportedAttachmentError(new Error("Functionality not supported"))).toBe(true);
    expect(isUnsupportedAttachmentError(new Error("functionality not supported: nope"))).toBe(true);
    expect(isUnsupportedAttachmentError({ name: "UnsupportedFunctionalityError" })).toBe(true);
  });

  it("detects text-like media types", () => {
    expect(isTextLikeMediaType("text/plain")).toBe(true);
    expect(isTextLikeMediaType("application/json")).toBe(true);
    expect(isTextLikeMediaType("application/pdf")).toBe(false);
  });

  it("extracts text content from file attachments", () => {
    const a1 = {
      kind: "file",
      mediaType: "application/json",
      bytes: new TextEncoder().encode('{"ok":true}'),
      filename: "a.json",
    } as unknown as AssetAttachment;
    expect(getTextContentFromAttachment(a1)).toMatchObject({ content: '{"ok":true}' });

    const a2 = {
      kind: "file",
      mediaType: "application/xml",
      bytes: new TextEncoder().encode("<ok/>"),
      filename: "a.xml",
    } as unknown as AssetAttachment;
    expect(getTextContentFromAttachment(a2)?.content).toContain("<ok/>");

    const a3 = {
      kind: "file",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7"),
    } as unknown as AssetAttachment;
    expect(getTextContentFromAttachment(a3)).toBeNull();
  });

  it("rejects archive media types", () => {
    const zip = {
      kind: "file",
      mediaType: "application/zip",
      bytes: new Uint8Array([1]),
    } as unknown as AssetAttachment;
    expect(() => assertAssetMediaTypeSupported({ attachment: zip, sizeLabel: "1B" })).toThrow(
      /Unsupported file type/i,
    );
  });

  it("passes through non-archive attachments", () => {
    const txt = {
      kind: "file",
      mediaType: "text/plain",
      bytes: new Uint8Array([1, 2]),
    } as unknown as AssetAttachment;
    expect(() => assertAssetMediaTypeSupported({ attachment: txt, sizeLabel: null })).not.toThrow();
  });

  it("returns raw bytes for file attachments", () => {
    const bytes = new Uint8Array([3, 4, 5]);
    const fileAttachment = {
      kind: "file",
      mediaType: "application/octet-stream",
      bytes,
    } as unknown as AssetAttachment;
    expect(getFileBytesFromAttachment(fileAttachment)).toBe(bytes);

    const nonFile = {
      kind: "image",
      mediaType: "image/png",
      bytes,
    } as unknown as AssetAttachment;
    expect(getFileBytesFromAttachment(nonFile)).toBeNull();
  });

  it("writes CLI attachment paths for asset URLs", async () => {
    const bytes = new Uint8Array([65, 66, 67]);
    const attachment = {
      kind: "file",
      mediaType: "application/json",
      bytes,
      filename: "data.json",
    } as unknown as AssetAttachment;
    const filePath = await ensureCliAttachmentPath({
      sourceKind: "asset-url",
      sourceLabel: "https://example.com/data.json",
      attachment,
    });
    const contents = await fs.readFile(filePath);
    expect(contents).toEqual(Buffer.from(bytes));
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });

  it("strips directory components from caller-supplied filenames", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const attachment = {
      kind: "file",
      mediaType: "application/octet-stream",
      bytes,
      filename: "../../escape.bin",
    } as unknown as AssetAttachment;
    const filePath = await ensureCliAttachmentPath({
      sourceKind: "asset-url",
      sourceLabel: "https://example.com/escape.bin",
      attachment,
    });
    const dir = path.dirname(filePath);
    expect(path.basename(filePath)).toBe("escape.bin");
    // The written file must stay inside the freshly-created temp dir.
    expect(path.relative(dir, filePath).includes("..")).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("throws when CLI attachment bytes are missing", async () => {
    const attachment = {
      kind: "file",
      mediaType: "application/json",
      bytes: null,
    } as unknown as AssetAttachment;
    await expect(
      ensureCliAttachmentPath({
        sourceKind: "asset-url",
        sourceLabel: "https://example.com/data.json",
        attachment,
      }),
    ).rejects.toThrow("CLI attachment missing bytes");
  });

  it("keeps file source paths as-is", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-asset-"));
    const filePath = path.join(base, "sample.txt");
    await fs.writeFile(filePath, "ok");
    const attachment = {
      kind: "file",
      mediaType: "text/plain",
      bytes: new Uint8Array([1]),
      filename: "sample.txt",
    } as unknown as AssetAttachment;
    const resolved = await ensureCliAttachmentPath({
      sourceKind: "file",
      sourceLabel: filePath,
      attachment,
    });
    expect(resolved).toBe(filePath);
    await fs.rm(base, { recursive: true, force: true });
  });

  it("detects native file attachment support", () => {
    expect(
      supportsNativeFileAttachment({
        provider: "anthropic",
        attachment: { kind: "file", mediaType: "application/pdf" },
      }),
    ).toBe(true);
    expect(
      supportsNativeFileAttachment({
        provider: "openai",
        attachment: { kind: "file", mediaType: "application/pdf" },
      }),
    ).toBe(true);
    expect(
      supportsNativeFileAttachment({
        provider: "google",
        attachment: { kind: "file", mediaType: "application/pdf" },
      }),
    ).toBe(true);
    expect(
      supportsNativeFileAttachment({
        provider: "xai",
        attachment: { kind: "file", mediaType: "application/pdf" },
      }),
    ).toBe(false);
    expect(
      supportsNativeFileAttachment({
        provider: "openai",
        attachment: { kind: "image", mediaType: "image/png" },
      }),
    ).toBe(false);
  });

  it("flags media types that should use markitdown", () => {
    expect(shouldMarkitdownConvertMediaType("application/pdf")).toBe(true);
    expect(shouldMarkitdownConvertMediaType("text/html")).toBe(true);
    expect(shouldMarkitdownConvertMediaType("application/vnd.ms-excel")).toBe(true);
    expect(shouldMarkitdownConvertMediaType("application/json")).toBe(false);
  });
});

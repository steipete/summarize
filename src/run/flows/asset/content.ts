import { CliError } from "../../../locale.js";
import { convertToMarkdownWithMarkitdown } from "../../../markitdown.js";
import { type AssetAttachment, getTextContentFromAttachment } from "../../attachments.js";
import { MAX_TEXT_BYTES_DEFAULT } from "../../constants.js";
import { hasUvxCli } from "../../env.js";
import { withUvxTip } from "../../tips.js";

export type AssetConversionContext = {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  execFileImpl: Parameters<typeof convertToMarkdownWithMarkitdown>[0]["execFileImpl"];
  timeoutMs: number;
};

export function readAssetText(attachment: AssetAttachment) {
  const text = getTextContentFromAttachment(attachment);
  if (text) assertTextSize(text.bytes, "text");
  return text;
}

export async function convertAssetToMarkdown(
  ctx: AssetConversionContext,
  attachment: AssetAttachment,
  bytes: Uint8Array,
) {
  if (!hasUvxCli(ctx.env)) {
    throw withUvxTip(
      new CliError("error.preprocessMissing", { mediaType: String(attachment.mediaType) }),
      ctx.env,
    );
  }
  let converted: Awaited<ReturnType<typeof convertToMarkdownWithMarkitdown>>;
  try {
    converted = await convertToMarkdownWithMarkitdown({
      bytes,
      filenameHint: attachment.filename,
      mediaTypeHint: attachment.mediaType,
      uvxCommand: ctx.envForRun.UVX_PATH,
      timeoutMs: ctx.timeoutMs,
      env: ctx.env,
      execFileImpl: ctx.execFileImpl,
      ocrFallback: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError("error.preprocessFailed", {
      mediaType: String(attachment.mediaType),
      message: String(message),
    });
  }
  assertTextSize(Buffer.byteLength(converted.markdown, "utf8"), "markdown");
  return converted;
}

function assertTextSize(bytes: number, kind: "text" | "markdown") {
  if (bytes > MAX_TEXT_BYTES_DEFAULT) {
    throw new CliError("error.textTooLarge", {
      kind,
      size: bytes / 1024 ** 2,
      limit: MAX_TEXT_BYTES_DEFAULT / 1024 ** 2,
    });
  }
}

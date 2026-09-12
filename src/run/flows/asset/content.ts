import { convertToMarkdownWithMarkitdown } from "../../../markitdown.js";
import { formatBytes } from "../../../tty/format.js";
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
  if (text) assertTextSize(text.bytes, "Text file");
  return text;
}

export async function convertAssetToMarkdown(
  ctx: AssetConversionContext,
  attachment: AssetAttachment,
  bytes: Uint8Array,
) {
  if (!hasUvxCli(ctx.env)) {
    throw withUvxTip(
      new Error(`Missing uvx/markitdown for preprocessing ${attachment.mediaType}.`),
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
    throw new Error(`Failed to preprocess ${attachment.mediaType} with markitdown: ${message}.`);
  }
  assertTextSize(Buffer.byteLength(converted.markdown, "utf8"), "Preprocessed Markdown");
  return converted;
}

function assertTextSize(bytes: number, label: string) {
  if (bytes > MAX_TEXT_BYTES_DEFAULT) {
    throw new Error(
      `${label} too large (${formatBytes(bytes)}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`,
    );
  }
}

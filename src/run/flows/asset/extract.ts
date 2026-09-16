import { applyContentBudget } from "@steipete/summarize-core/content";
import { CliError } from "../../../locale.js";
import {
  type AssetAttachment,
  getFileBytesFromAttachment,
  shouldMarkitdownConvertMediaType,
} from "../../attachments.js";
import type { ExtractDiagnosticsForFinishLine } from "../../finish-line.js";
import { type AssetConversionContext, convertAssetToMarkdown, readAssetText } from "./content.js";

export type AssetExtractContext = AssetConversionContext & {
  preprocessMode: "off" | "auto" | "always";
};

export type AssetExtractResult = {
  content: string;
  diagnostics: ExtractDiagnosticsForFinishLine;
};

const baseDiagnostics: ExtractDiagnosticsForFinishLine = {
  strategy: "html",
  firecrawl: { used: false },
  markdown: { used: false, provider: null },
  transcript: { textProvided: false, provider: null },
};

export async function extractAssetContent({
  ctx,
  attachment,
  maxCharacters,
}: {
  ctx: AssetExtractContext;
  attachment: AssetAttachment;
  maxCharacters?: number | null;
}): Promise<AssetExtractResult> {
  const textContent = readAssetText(attachment);
  if (textContent) {
    return {
      content:
        typeof maxCharacters === "number"
          ? applyContentBudget(textContent.content, maxCharacters).content
          : textContent.content,
      diagnostics: baseDiagnostics,
    };
  }

  if (attachment.kind === "image") {
    const name = attachment.filename ?? "image";
    throw new CliError("error.noExtractableText", {
      name: String(name),
      mediaType: String(attachment.mediaType),
    });
  }

  const fileBytes = getFileBytesFromAttachment(attachment);
  if (!fileBytes) {
    throw new CliError("error.extractMissingBytes");
  }

  if (ctx.preprocessMode === "off") {
    throw new CliError("error.extractBinary", { mediaType: String(attachment.mediaType) });
  }
  if (!shouldMarkitdownConvertMediaType(attachment.mediaType)) {
    const name = attachment.filename ?? "file";
    throw new CliError("error.extractUnsupported", {
      name: String(name),
      mediaType: String(attachment.mediaType),
    });
  }
  const { markdown, usedOcr } = await convertAssetToMarkdown(ctx, attachment, fileBytes);

  return {
    content:
      typeof maxCharacters === "number"
        ? applyContentBudget(markdown, maxCharacters).content
        : markdown,
    diagnostics: {
      ...baseDiagnostics,
      markdown: { used: true, provider: null, notes: usedOcr ? "markitdown+ocr" : "markitdown" },
    },
  };
}

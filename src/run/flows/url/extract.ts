import type { ExtractedLinkContent, FetchLinkContentOptions } from "../../../content/index.js";
import { type CliLocale, createCliTranslator } from "../../../locale.js";
import { formatBytes } from "../../../tty/format.js";
import { withBirdTip } from "../../bird.js";
import type { FinishLabel } from "../../finish-line-types.js";
import { buildSummaryFinishLabel } from "../../finish-line.js";
import { formatOptionalNumber, formatOptionalString } from "../../format.js";
import { writeVerbose } from "../../logging.js";

export type UrlExtractionUi = {
  contentSizeLabel: string;
  viaSourceLabel: string;
  footerParts: string[];
  finishSourceLabel: FinishLabel | null;
};

export async function fetchLinkContentWithBirdTip({
  client,
  url,
  options,
  env,
}: {
  client: {
    fetchLinkContent: (
      url: string,
      options?: FetchLinkContentOptions,
    ) => Promise<ExtractedLinkContent>;
  };
  url: string;
  options: FetchLinkContentOptions;
  env: Record<string, string | undefined>;
}): Promise<ExtractedLinkContent> {
  try {
    return await client.fetchLinkContent(url, options);
  } catch (error) {
    throw withBirdTip(error, url, env);
  }
}

export function deriveExtractionUi(
  extracted: ExtractedLinkContent,
  locale: CliLocale = "en",
): UrlExtractionUi {
  const t = createCliTranslator(locale);
  const extractedContentBytes = Buffer.byteLength(extracted.content, "utf8");
  const contentSizeLabel = formatBytes(extractedContentBytes, locale);
  const twitterStrategy =
    extracted.diagnostics.strategy === "xurl" || extracted.diagnostics.strategy === "bird"
      ? extracted.diagnostics.strategy
      : null;

  const viaSources: string[] = [];
  if (twitterStrategy) {
    viaSources.push(twitterStrategy);
  }
  if (extracted.diagnostics.strategy === "twitter-syndication") {
    viaSources.push("twitter-syndication");
  }
  if (extracted.diagnostics.strategy === "nitter") {
    viaSources.push("Nitter");
  }
  if (extracted.diagnostics.firecrawl.used) {
    viaSources.push("Firecrawl");
  }
  const viaSourceLabel = viaSources.length > 0 ? `, ${viaSources.join("+")}` : "";

  const footerParts: string[] = [];
  if (extracted.diagnostics.strategy === "html") footerParts.push("html");
  if (twitterStrategy) footerParts.push(twitterStrategy);
  if (extracted.diagnostics.strategy === "twitter-syndication")
    footerParts.push("twitter-syndication");
  if (extracted.diagnostics.strategy === "nitter") footerParts.push("nitter");
  if (extracted.diagnostics.firecrawl.used) footerParts.push("firecrawl");
  if (extracted.diagnostics.markdown.used) {
    if (extracted.diagnostics.markdown.provider === "llm") {
      footerParts.push(
        t("footer.markdown", { source: extracted.diagnostics.markdown.notes ?? "html" }),
      );
    } else {
      footerParts.push("markdown");
    }
  }
  if (extracted.diagnostics.transcript.textProvided) {
    footerParts.push(
      t("footer.transcript", { provider: extracted.diagnostics.transcript.provider ?? "unknown" }),
    );
  }
  if (extracted.isVideoOnly && extracted.video) {
    footerParts.push(t("footer.video", { source: extracted.video.kind }));
  }

  const finishSourceLabel = buildSummaryFinishLabel({
    extracted: { diagnostics: extracted.diagnostics, wordCount: extracted.wordCount },
  });

  return {
    contentSizeLabel,
    viaSourceLabel,
    footerParts,
    finishSourceLabel,
  };
}

export function logExtractionDiagnostics({
  extracted,
  stderr,
  verbose,
  verboseColor,
  env,
}: {
  extracted: ExtractedLinkContent;
  stderr: NodeJS.WritableStream;
  verbose: boolean;
  verboseColor: boolean;
  env?: Record<string, string | undefined>;
}) {
  writeVerbose(
    stderr,
    verbose,
    `extract done strategy=${extracted.diagnostics.strategy} siteName=${formatOptionalString(
      extracted.siteName,
    )} title=${formatOptionalString(extracted.title)} transcriptSource=${formatOptionalString(
      extracted.transcriptSource,
    )}`,
    verboseColor,
    env,
  );
  writeVerbose(
    stderr,
    verbose,
    `extract stats characters=${extracted.totalCharacters} words=${extracted.wordCount} transcriptCharacters=${formatOptionalNumber(
      extracted.transcriptCharacters,
    )} transcriptLines=${formatOptionalNumber(extracted.transcriptLines)}`,
    verboseColor,
    env,
  );
  writeVerbose(
    stderr,
    verbose,
    `extract firecrawl attempted=${extracted.diagnostics.firecrawl.attempted} used=${extracted.diagnostics.firecrawl.used} notes=${formatOptionalString(
      extracted.diagnostics.firecrawl.notes ?? null,
    )}`,
    verboseColor,
    env,
  );
  writeVerbose(
    stderr,
    verbose,
    `extract markdown requested=${extracted.diagnostics.markdown.requested} used=${extracted.diagnostics.markdown.used} provider=${formatOptionalString(
      extracted.diagnostics.markdown.provider ?? null,
    )} notes=${formatOptionalString(extracted.diagnostics.markdown.notes ?? null)}`,
    verboseColor,
    env,
  );
  writeVerbose(
    stderr,
    verbose,
    `extract transcript textProvided=${extracted.diagnostics.transcript.textProvided} provider=${formatOptionalString(
      extracted.diagnostics.transcript.provider ?? null,
    )} attemptedProviders=${
      extracted.diagnostics.transcript.attemptedProviders.length > 0
        ? extracted.diagnostics.transcript.attemptedProviders.join(",")
        : "none"
    } notes=${formatOptionalString(extracted.diagnostics.transcript.notes ?? null)}`,
    verboseColor,
    env,
  );
}

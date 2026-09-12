import type { ExtractedLinkContent } from "../../../content/index.js";
import type { RunMetricsReport } from "../../../costs.js";
import { formatOutputLanguageForJson } from "../../../language.js";
import { buildRunJsonEnv } from "../../../shared/run-api-status.js";
import type { UrlFlowContext } from "./types.js";

export function buildUrlJsonInput(options: {
  flags: UrlFlowContext["flags"];
  url: string;
  effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
  modelLabel: string | null;
}) {
  const { flags, url, effectiveMarkdownMode, modelLabel } = options;
  return {
    kind: "url" as const,
    url,
    timeoutMs: flags.timeoutMs,
    youtube: flags.youtubeMode,
    videoMode: flags.videoMode,
    embeddedVideo: flags.embeddedVideoMode,
    firecrawl: flags.firecrawlMode,
    format: flags.format,
    markdown: effectiveMarkdownMode,
    timestamps: flags.transcriptTimestamps,
    length:
      flags.lengthArg.kind === "preset"
        ? { kind: "preset" as const, preset: flags.lengthArg.preset }
        : { kind: "chars" as const, maxCharacters: flags.lengthArg.maxCharacters },
    maxOutputTokens: flags.maxOutputTokensArg,
    model: modelLabel,
    language: formatOutputLanguageForJson(flags.outputLanguage),
  };
}

type SlidesResult = Awaited<
  ReturnType<typeof import("../../../slides/index.js").extractSlidesForSource>
>;

export async function writeUrlJsonOutput({
  ctx,
  url,
  extracted,
  effectiveMarkdownMode,
  prompt,
  slides,
  summary,
  llm,
}: {
  ctx: UrlFlowContext;
  url: string;
  extracted: ExtractedLinkContent;
  effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
  prompt: string;
  slides?: SlidesResult | null;
  summary: string | null;
  llm: {
    provider: string;
    model: string;
    maxCompletionTokens: number | null;
    strategy: "single";
  } | null;
}): Promise<RunMetricsReport | null> {
  const { io, flags, model, hooks } = ctx;
  hooks.clearProgressForStdout();
  const finishReport = flags.shouldComputeReport ? await hooks.buildReport() : null;
  const payload = {
    input: {
      ...buildUrlJsonInput({
        flags,
        url,
        effectiveMarkdownMode,
        modelLabel: model.requestedModelLabel,
      }),
    },
    env: buildRunJsonEnv(model.apiStatus),
    extracted,
    slides,
    prompt,
    llm,
    metrics: flags.metricsEnabled ? finishReport : null,
    summary,
  };
  io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  hooks.restoreProgressAfterStdout?.();
  return finishReport;
}

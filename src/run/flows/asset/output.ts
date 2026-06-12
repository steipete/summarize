import { render as renderMarkdownAnsi } from "markdansi";
import type { RunMetricsReport } from "../../../costs.js";
import { buildRunJsonEnv, type RunApiAvailability } from "../../../shared/run-api-status.js";
import { buildExtractFinishLabel, writeFinishLine } from "../../finish-line.js";
import { prepareMarkdownForTerminal } from "../../markdown.js";
import { isRichTty, markdownRenderWidth, supportsColor } from "../../terminal.js";
import type { AssetExtractResult } from "./extract.js";

export async function outputExtractedAsset({
  io,
  flags,
  hooks,
  url,
  sourceLabel,
  attachment,
  extracted,
  elapsedMs,
  report,
  costUsd,
  apiStatus,
}: {
  io: {
    env: Record<string, string | undefined>;
    envForRun: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
  flags: {
    timeoutMs: number;
    preprocessMode: "off" | "auto" | "always";
    format: "text" | "markdown";
    plain: boolean;
    json: boolean;
    metricsEnabled: boolean;
    metricsDetailed: boolean;
    verboseColor: boolean;
  };
  hooks: {
    clearProgressForStdout: () => void;
    restoreProgressAfterStdout?: (() => void) | null;
  };
  url: string;
  sourceLabel: string;
  attachment: {
    mediaType: string;
    filename: string | null;
  };
  extracted: AssetExtractResult;
  elapsedMs: number;
  report: RunMetricsReport | null;
  costUsd: number | null;
  apiStatus: RunApiAvailability;
}): Promise<void> {
  hooks.clearProgressForStdout();
  const finishLabel = buildExtractFinishLabel({
    extracted: { diagnostics: extracted.diagnostics },
    format: flags.format,
    markdownMode: "off",
    hasMarkdownLlmCall: false,
  });

  if (flags.json) {
    const payload = {
      input: {
        kind: "asset-url" as const,
        url,
        timeoutMs: flags.timeoutMs,
        format: flags.format,
        preprocess: flags.preprocessMode,
      },
      env: buildRunJsonEnv(apiStatus),
      extracted: {
        kind: "asset" as const,
        source: sourceLabel,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
        content: extracted.content,
      },
      prompt: null,
      llm: null,
      metrics: flags.metricsEnabled ? report : null,
      summary: null,
    };
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    hooks.restoreProgressAfterStdout?.();
    if (flags.metricsEnabled && report) {
      writeFinishLine({
        stderr: io.stderr,
        env: io.envForRun,
        elapsedMs,
        label: finishLabel,
        model: null,
        report,
        costUsd,
        detailed: flags.metricsDetailed,
        extraParts: null,
        color: flags.verboseColor,
      });
    }
    return;
  }

  const rendered =
    flags.format === "markdown" && !flags.plain && isRichTty(io.stdout)
      ? renderMarkdownAnsi(prepareMarkdownForTerminal(extracted.content), {
          width: markdownRenderWidth(io.stdout, io.env),
          wrap: true,
          color: supportsColor(io.stdout, io.envForRun),
          hyperlinks: true,
        })
      : extracted.content;

  if (flags.format === "markdown" && !flags.plain && isRichTty(io.stdout)) {
    io.stdout.write(`\n${rendered.replace(/^\n+/, "")}`);
  } else {
    io.stdout.write(rendered);
  }
  if (!rendered.endsWith("\n")) {
    io.stdout.write("\n");
  }
  hooks.restoreProgressAfterStdout?.();

  if (flags.metricsEnabled && report) {
    writeFinishLine({
      stderr: io.stderr,
      env: io.envForRun,
      elapsedMs,
      label: finishLabel,
      model: null,
      report,
      costUsd,
      detailed: flags.metricsDetailed,
      extraParts: null,
      color: flags.verboseColor,
    });
  }
}

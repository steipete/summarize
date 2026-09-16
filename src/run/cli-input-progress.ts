import type { SummarizeEvent } from "../application/summarize-contracts.js";
import { createCliTranslator, resolveCliLocaleFromEnv } from "../locale.js";
import { formatBytes } from "../tty/format.js";
import { startOscProgress } from "../tty/osc-progress.js";
import { startSpinner } from "../tty/spinner.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
import type { ProgressGate } from "./progress.js";

type InputProgressEvent = Extract<SummarizeEvent, { type: "input-progress" }>;

export type CliInputProgress = {
  handleEvent: (event: SummarizeEvent) => void;
  stop: () => void;
};

function isRemoteSource(source: string): boolean {
  try {
    const protocol = new URL(source).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function createCliInputProgress(options: {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  stderr: NodeJS.WritableStream;
  enabled: boolean;
  progressGate: Pick<ProgressGate, "setClearProgressBeforeStdout" | "clearProgressIfCurrent">;
}): CliInputProgress {
  const theme = createThemeRenderer({
    themeName: resolveThemeNameFromSources({
      env: options.envForRun.SUMMARIZE_THEME,
    }),
    enabled: options.enabled,
    trueColor: resolveTrueColor(options.envForRun),
  });
  let current: InputProgressEvent | null = null;
  let modelId: string | null = null;
  let spinner: ReturnType<typeof startSpinner> | null = null;
  let stopOscProgress: (() => void) | null = null;
  let stopped = false;
  const locale = resolveCliLocaleFromEnv(options.envForRun);
  const t = createCliTranslator(locale, {
    uiLabel: theme.label,
    uiDetail: theme.dim,
    uiValue: theme.accent,
  });
  const sizeLabel = () =>
    typeof current?.sizeBytes === "number" ? formatBytes(current.sizeBytes, locale) : null;
  const phase = (event: InputProgressEvent) =>
    event.phase === "loading" && isRemoteSource(event.source) ? "downloading" : event.phase;
  const render = () => {
    if (!current) return "";
    const size = sizeLabel();
    const details = [current.phase !== "transcribing" ? current.mediaType : null, size]
      .filter(Boolean)
      .join(", ");
    const info =
      current.phase === "loading"
        ? size
          ? `(${size})`
          : ""
        : current.filename
          ? `${current.filename}${details ? ` (${details})` : ""}`
          : details;
    return t("progress.input", {
      phase: phase(current),
      info,
      hasInfo: Boolean(info),
      model: modelId ?? "",
      hasModel: Boolean(modelId),
    });
  };
  const oscLabel = (event: InputProgressEvent) => t("progress.inputLabel", { phase: phase(event) });
  const pauseProgressLine = () => {
    spinner?.pause();
    return () => spinner?.resume();
  };
  const ensureStarted = (event: InputProgressEvent) => {
    if (spinner || stopped) return;
    stopOscProgress = startOscProgress({
      label: oscLabel(event),
      indeterminate: true,
      env: options.env,
      isTty: options.enabled,
      write: (data: string) => options.stderr.write(data),
    });
    spinner = startSpinner({
      text: render(),
      enabled: options.enabled,
      stream: options.stderr,
      color: theme.palette.spinner,
    });
    options.progressGate.setClearProgressBeforeStdout(pauseProgressLine);
  };

  return {
    handleEvent: (event) => {
      if (stopped) return;
      if (event.type === "input-progress") {
        current = event;
        ensureStarted(event);
        spinner?.setText(render());
        return;
      }
      if (event.type === "model-selected" && spinner) {
        modelId = event.modelId;
        spinner.setText(render());
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      options.progressGate.clearProgressIfCurrent(pauseProgressLine);
      spinner?.stopAndClear();
      stopOscProgress?.();
    },
  };
}

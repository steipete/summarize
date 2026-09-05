import type { SummarizeEvent } from "../application/summarize-contracts.js";
import { resolveCliLocaleFromEnv, translateCliText } from "../locale.js";
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
  const localize = (text: string) => translateCliText(text, locale);

  const modelSuffix = () =>
    modelId ? `${theme.dim(" (model: ")}${theme.accent(modelId)}${theme.dim(")")}` : "";
  const sizeLabel = () =>
    typeof current?.sizeBytes === "number" ? formatBytes(current.sizeBytes) : null;
  const metadata = ({ includeMediaType }: { includeMediaType: boolean }) => {
    if (!current) return "";
    const details = [includeMediaType ? current.mediaType : null, sizeLabel()].filter(
      (value): value is string => Boolean(value),
    );
    const name = current.filename;
    const base =
      name && details.length > 0
        ? `${name} ${theme.dim("(")}${details.join(", ")}${theme.dim(")")}`
        : name || details.join(", ");
    return `${base}${modelSuffix()}`;
  };
  const render = () => {
    if (!current) return "";
    if (current.phase === "loading") {
      const label = localize(isRemoteSource(current.source) ? "Downloading file" : "Loading file");
      const size = sizeLabel();
      return `${theme.label(label)}${theme.dim(size ? ` (${size})…` : "…")}`;
    }
    const label =
      current.phase === "transcribing"
        ? localize("Transcribing")
        : current.phase === "extracting"
          ? localize("Extracting text")
          : localize("Summarizing");
    const meta = metadata({ includeMediaType: current.phase !== "transcribing" });
    return meta
      ? `${theme.label(label)} ${meta}${theme.dim("…")}`
      : `${theme.label(label)}${theme.dim("…")}`;
  };
  const oscLabel = (event: InputProgressEvent) => {
    if (event.phase === "loading") {
      return localize(isRemoteSource(event.source) ? "Downloading file" : "Loading file");
    }
    if (event.phase === "transcribing") return localize("Transcribing media");
    if (event.phase === "extracting") return localize("Extracting text");
    return localize("Summarizing");
  };
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

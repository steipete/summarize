import fs from "node:fs/promises";
import path from "node:path";
import {
  type AcquiredAssetInput,
  acquireLocalAssetInput,
  acquireRemoteAssetInput,
  createRemoteMediaInput,
  isPdfAssetPath,
  isTranscribableAssetPath,
  resolveUrlAssetRoute,
} from "../../../application/input-acquisition.js";
import { type InputTarget } from "../../../content/asset.js";
import { formatBytes } from "../../../tty/format.js";
import { startOscProgress } from "../../../tty/osc-progress.js";
import { startSpinner } from "../../../tty/spinner.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../../../tty/theme.js";
import type { AssetSummaryResult, SummarizeAssetArgs } from "./types.js";

const createProgressTheme = (
  envForRun: Record<string, string | undefined> | undefined,
  enabled: boolean,
) => {
  const env = envForRun ?? {};
  return createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: env.SUMMARIZE_THEME }),
    enabled,
    trueColor: resolveTrueColor(env),
  });
};

const renderStatus = (theme: ReturnType<typeof createProgressTheme>, label: string, detail = "…") =>
  `${theme.label(label)}${theme.dim(detail)}`;

const renderStatusWithMeta = (
  theme: ReturnType<typeof createProgressTheme>,
  label: string,
  meta: string,
  suffix = "…",
) => `${theme.label(label)} ${meta}${theme.dim(suffix)}`;

const renderModelSuffix = (theme: ReturnType<typeof createProgressTheme>, modelId: string) =>
  `${theme.dim(" (model: ")}${theme.accent(modelId)}${theme.dim(")")}`;

export const isTranscribableExtension = isTranscribableAssetPath;
export const isPdfExtension = isPdfAssetPath;

function formatTranscriptionMeta({
  filename,
  sizeLabel,
  dim,
}: {
  filename: string;
  sizeLabel: string | null;
  dim: (value: string) => string;
}): string {
  const details = sizeLabel ? `${sizeLabel}` : "";
  return details ? `${filename} ${dim("(")}${details}${dim(")")}` : filename;
}

function setTranscribingSpinnerText({
  spinner,
  theme,
  meta,
  modelId,
}: {
  spinner: ReturnType<typeof startSpinner>;
  theme: ReturnType<typeof createProgressTheme>;
  meta: string;
  modelId?: string;
}) {
  const modelLabel = modelId ? renderModelSuffix(theme, modelId) : "";
  spinner.setText(renderStatusWithMeta(theme, "Transcribing", `${meta}${modelLabel}`));
}

async function runMediaTranscription({
  ctx,
  sourceKind,
  sourceLabel,
  filename,
  sizeLabel,
  spinner,
}: {
  ctx: AssetInputContext;
  sourceKind: "file" | "asset-url";
  sourceLabel: string;
  filename: string;
  sizeLabel: string | null;
  spinner: ReturnType<typeof startSpinner>;
}): Promise<void> {
  const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled);
  const dim = (value: string) => theme.dim(value);
  const meta = formatTranscriptionMeta({ filename, sizeLabel, dim });

  if (ctx.progressEnabled) {
    setTranscribingSpinnerText({ spinner, theme, meta });
  }

  await ctx.summarizeMediaFile?.({
    sourceKind,
    sourceLabel,
    attachment: {
      kind: "file",
      filename,
      mediaType: "audio/mpeg", // The media executor detects the actual type.
      bytes: new Uint8Array(0), // Placeholder; media execution reads from the source path.
    },
    onModelChosen: (modelId) => {
      if (!ctx.progressEnabled) return;
      setTranscribingSpinnerText({ spinner, theme, meta, modelId });
    },
  });
}

export type AssetInputContext = {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  stderr: NodeJS.WritableStream;
  progressEnabled: boolean;
  timeoutMs: number;
  trackedFetch: typeof fetch;
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<AssetSummaryResult>;
  summarizeMediaFile?: (args: SummarizeAssetArgs) => Promise<void>;
  setClearProgressBeforeStdout: (fn: (() => undefined | (() => void)) | null) => void;
  clearProgressIfCurrent: (fn: () => void) => void;
};

type UrlAssetHandler = (args: {
  loaded: Pick<AcquiredAssetInput, "attachment" | "sourceLabel">;
  spinner: ReturnType<typeof startSpinner>;
  clearProgressLine: () => void;
}) => Promise<void>;

export async function handleFileInput(
  ctx: AssetInputContext,
  inputTarget: InputTarget,
): Promise<boolean> {
  if (inputTarget.kind !== "file") return false;

  let sizeLabel: string | null = null;
  const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled);
  try {
    const stat = await fs.stat(inputTarget.filePath);
    if (stat.isFile()) {
      sizeLabel = formatBytes(stat.size);
    }
  } catch {
    // Ignore size preflight; loadLocalAsset will throw a user-friendly error if needed.
  }

  const stopOscProgress = startOscProgress({
    label: "Loading file",
    indeterminate: true,
    env: ctx.env,
    isTty: ctx.progressEnabled,
    write: (data: string) => ctx.stderr.write(data),
  });
  const spinner = startSpinner({
    text: renderStatus(theme, "Loading file", sizeLabel ? ` (${sizeLabel})…` : "…"),
    enabled: ctx.progressEnabled,
    stream: ctx.stderr,
    color: theme.palette.spinner,
  });
  let stopped = false;
  const stopProgress = () => {
    if (stopped) return;
    stopped = true;
    spinner.stopAndClear();
    stopOscProgress();
  };
  const pauseProgressLine = () => {
    spinner.pause();
    return () => spinner.resume();
  };
  ctx.setClearProgressBeforeStdout(pauseProgressLine);
  try {
    const acquired = await acquireLocalAssetInput({ filePath: inputTarget.filePath });
    if (acquired.kind === "resolved-media" && ctx.summarizeMediaFile) {
      const filename = acquired.attachment.filename ?? path.basename(inputTarget.filePath);
      await runMediaTranscription({
        ctx,
        sourceKind: "file",
        sourceLabel: acquired.sourceLabel,
        filename,
        sizeLabel,
        spinner,
      });
      return true;
    }

    const dim = (value: string) => theme.dim(value);

    if (ctx.progressEnabled) {
      const mt = acquired.attachment.mediaType;
      const name = acquired.attachment.filename;
      const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt;
      const meta = name ? `${name} ${dim("(")}${details}${dim(")")}` : details;
      spinner.setText(renderStatusWithMeta(theme, "Summarizing", meta));
    }

    await ctx.summarizeAsset({
      sourceKind: "file",
      sourceLabel: acquired.sourceLabel,
      attachment: acquired.attachment,
      onModelChosen: (modelId) => {
        if (!ctx.progressEnabled) return;
        const mt = acquired.attachment.mediaType;
        const name = acquired.attachment.filename;
        const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt;
        const meta = name ? `${name} ${dim("(")}${details}${dim(")")}` : details;
        const modelLabel = renderModelSuffix(theme, modelId);
        spinner.setText(renderStatusWithMeta(theme, "Summarizing", `${meta}${modelLabel}`));
      },
    });
    return true;
  } finally {
    ctx.clearProgressIfCurrent(pauseProgressLine);
    stopProgress();
  }
}

export async function withUrlAsset(
  ctx: AssetInputContext,
  url: string,
  isYoutubeUrl: boolean,
  handler: UrlAssetHandler,
  options: { detectUnknownAssetUrls?: boolean; assumeAsset?: boolean } = {},
): Promise<boolean> {
  if (!url || isYoutubeUrl) return false;

  const route = await resolveUrlAssetRoute({
    url,
    isYoutubeUrl,
    fetchImpl: ctx.trackedFetch,
    timeoutMs: ctx.timeoutMs,
    detectUnknownAssetUrls: options.detectUnknownAssetUrls,
    assumeAsset: options.assumeAsset,
  });
  if (route === "none") return false;

  if (route === "media" && ctx.summarizeMediaFile) {
    const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled);
    const mediaInput = createRemoteMediaInput(url);
    const filename = mediaInput.attachment.filename ?? "media";
    const stopOscProgress = startOscProgress({
      label: "Transcribing media",
      indeterminate: true,
      env: ctx.env,
      isTty: ctx.progressEnabled,
      write: (data: string) => ctx.stderr.write(data),
    });
    const spinner = startSpinner({
      text: renderStatusWithMeta(theme, "Transcribing", filename),
      enabled: ctx.progressEnabled,
      stream: ctx.stderr,
      color: theme.palette.spinner,
    });
    let stopped = false;
    const stopProgress = () => {
      if (stopped) return;
      stopped = true;
      spinner.stopAndClear();
      stopOscProgress();
    };
    const pauseProgressLine = () => {
      spinner.pause();
      return () => spinner.resume();
    };
    ctx.setClearProgressBeforeStdout(pauseProgressLine);
    try {
      await runMediaTranscription({
        ctx,
        sourceKind: "asset-url",
        sourceLabel: url,
        filename,
        sizeLabel: null,
        spinner,
      });
      return true;
    } finally {
      ctx.clearProgressIfCurrent(pauseProgressLine);
      stopProgress();
    }
  }

  const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled);
  const stopOscProgress = startOscProgress({
    label: "Downloading file",
    indeterminate: true,
    env: ctx.env,
    isTty: ctx.progressEnabled,
    write: (data: string) => ctx.stderr.write(data),
  });
  const spinner = startSpinner({
    text: renderStatus(theme, "Downloading file"),
    enabled: ctx.progressEnabled,
    stream: ctx.stderr,
    color: theme.palette.spinner,
  });
  let stopped = false;
  const stopProgress = () => {
    if (stopped) return;
    stopped = true;
    spinner.stopAndClear();
    stopOscProgress();
  };
  const pauseProgressLine = () => {
    spinner.pause();
    return () => spinner.resume();
  };
  ctx.setClearProgressBeforeStdout(pauseProgressLine);
  try {
    const acquired = await acquireRemoteAssetInput({
      url,
      fetchImpl: ctx.trackedFetch,
      timeoutMs: ctx.timeoutMs,
    });
    if (!acquired) return false;
    await handler({
      loaded: {
        sourceLabel: acquired.sourceLabel,
        attachment: acquired.attachment,
      },
      spinner,
      clearProgressLine: pauseProgressLine,
    });
    return true;
  } finally {
    ctx.clearProgressIfCurrent(pauseProgressLine);
    stopProgress();
  }
}

export async function handleUrlAsset(
  ctx: AssetInputContext,
  url: string,
  isYoutubeUrl: boolean,
): Promise<boolean> {
  // Media URL handling is now in withUrlAsset
  return withUrlAsset(ctx, url, isYoutubeUrl, async ({ loaded, spinner }) => {
    const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled);
    const dim = (value: string) => theme.dim(value);
    if (ctx.progressEnabled) {
      spinner.setText(renderStatusWithMeta(theme, "Summarizing", dim("file")));
    }
    await ctx.summarizeAsset({
      sourceKind: "asset-url",
      sourceLabel: loaded.sourceLabel,
      attachment: loaded.attachment,
      onModelChosen: (modelId) => {
        if (!ctx.progressEnabled) return;
        const modelLabel = renderModelSuffix(theme, modelId);
        spinner.setText(renderStatusWithMeta(theme, "Summarizing", `${dim("file")}${modelLabel}`));
      },
    });
  });
}

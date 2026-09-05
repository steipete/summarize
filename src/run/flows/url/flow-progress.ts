import {
  hasTurkishTranslation,
  resolveCliLocaleFromEnv,
  translateCliText,
} from "../../../locale.js";
import { createOscProgressController } from "../../../tty/osc-progress.js";
import { startSpinner } from "../../../tty/spinner.js";
import type { createThemeRenderer } from "../../../tty/theme.js";
import { createWebsiteProgress } from "../../../tty/website-progress.js";
import { createUrlProgressStatus } from "./progress-status.js";
import { composeUrlFlowHooks, type UrlFlowContext } from "./types.js";

function isMissingSlidesDependencyError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("missing ffmpeg") ||
    lower.includes("install ffmpeg") ||
    lower.includes("require yt-dlp") ||
    lower.includes("install yt-dlp") ||
    lower.includes("missing tesseract")
  );
}

export function writeSlidesBackgroundFailureWarning({
  ctx,
  theme,
  message,
}: {
  ctx: Pick<UrlFlowContext, "io" | "flags" | "hooks">;
  theme: ReturnType<typeof createThemeRenderer>;
  message: string;
}) {
  if (ctx.flags.json || ctx.flags.extractMode) return;
  ctx.hooks.clearProgressForStdout();
  const locale = resolveCliLocaleFromEnv(ctx.io.env);
  ctx.io.stderr.write(
    `${theme.warning(translateCliText("Warning:", locale))} ${translateCliText("--slides could not extract slide images:", locale)} ${message}\n`,
  );
  if (isMissingSlidesDependencyError(message)) {
    ctx.io.stderr.write(
      `${theme.dim(translateCliText("Install ffmpeg + yt-dlp for --slides, and tesseract for --slides-ocr.", locale))}\n`,
    );
  }
  ctx.hooks.restoreProgressAfterStdout?.();
}

export function createUrlFlowProgress({
  ctx,
  theme,
}: {
  ctx: UrlFlowContext;
  theme: ReturnType<typeof createThemeRenderer>;
}) {
  const { io, flags, hooks } = ctx;
  const locale = resolveCliLocaleFromEnv(io.env);
  const localize = (text: string) => translateCliText(text, locale);
  const oscProgress = createOscProgressController({
    label: localize("Fetching website"),
    env: io.env,
    isTty: flags.progressEnabled,
    write: (data: string) => io.stderr.write(data),
  });
  oscProgress.setIndeterminate(localize("Fetching website"));
  const spinner = startSpinner({
    text: `${theme.label(localize("Fetching website"))}${theme.dim(` (${localize("connecting")}…)`)}`,
    enabled: flags.progressEnabled,
    stream: io.stderr,
    color: theme.palette.spinner,
  });
  const styleLabel = (text: string) => theme.label(text);
  const styleDim = (text: string) => theme.dim(text);
  const renderStatus = (label: string, detail = "…") =>
    `${styleLabel(localize(label))}${styleDim(detail)}`;
  const renderStatusWithMeta = (label: string, meta: string, suffix = "…") =>
    `${styleLabel(localize(label))} ${meta}${styleDim(suffix)}`;
  const renderStatusFromText = (text: string) => {
    const match = text.match(/^([^:]+):(.*)$/);
    if (!match) return styleLabel(hasTurkishTranslation(text) ? localize(text) : text);
    return `${styleLabel(hasTurkishTranslation(match[1]) ? localize(match[1]) : match[1])}${styleDim(`:${match[2]}`)}`;
  };
  const progressStatus = createUrlProgressStatus({
    enabled: flags.progressEnabled,
    spinner,
    oscProgress,
  });
  const handleSignal = () => {
    try {
      spinner.stopAndClear();
    } catch {
      // ignore
    }
    oscProgress.clear();
  };
  const handleSigint = () => {
    handleSignal();
    process.exit(130);
  };
  const handleSigterm = () => {
    handleSignal();
    process.exit(143);
  };
  if (flags.progressEnabled) {
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
  }
  const progressHooks =
    !hooks.onSlidesProgress && flags.progressEnabled
      ? composeUrlFlowHooks(hooks, {
          onSlidesProgress: (text: string) => {
            const match = text.match(/(\d{1,3})%/);
            const percent = match ? Number(match[1]) : null;
            progressStatus.setSlides(
              renderStatusFromText(text),
              Number.isFinite(percent) && percent !== null ? percent : null,
            );
          },
        })
      : hooks;
  const websiteProgress = createWebsiteProgress({
    enabled: flags.progressEnabled,
    spinner,
    oscProgress,
    theme,
  });

  const stopProgress = () => {
    if (!flags.progressEnabled) return;
    websiteProgress?.stop?.();
    try {
      spinner.stopAndClear();
    } catch {
      // ignore
    }
    oscProgress.clear();
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  };

  return {
    progressStatus,
    hooks: progressHooks,
    pauseProgress: () => {
      spinner.pause();
      return () => spinner.resume();
    },
    renderStatus,
    renderStatusFromText,
    renderStatusWithMeta,
    spinner,
    styleDim,
    styleLabel,
    handleSigint,
    handleSigterm,
    stopProgress,
    websiteProgress,
  };
}

import {
  type CliMessageKey,
  type CliMessage,
  createCliTranslator,
  resolveCliLocaleFromEnv,
} from "../../../locale.js";
import { createOscProgressController } from "../../../tty/osc-progress.js";
import { startSpinner } from "../../../tty/spinner.js";
import type { createThemeRenderer } from "../../../tty/theme.js";
import { createWebsiteProgress } from "../../../tty/website-progress.js";
import { createUrlProgressStatus } from "./progress-status.js";
import { composeUrlFlowHooks, type UrlFlowContext } from "./types.js";

function isMissingSlidesDependencyError(message: string): boolean {
  const lower = message.toLowerCase();
  // i18n-ignore: Unformatted extraction/tool diagnostics; the UI warning is separately keyed.
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
    `${createCliTranslator(locale, { uiLabel: theme.warning })("warning.slidesFailed", { message })}\n`,
  );
  if (isMissingSlidesDependencyError(message)) {
    ctx.io.stderr.write(
      `${theme.dim(createCliTranslator(locale)("install.ffmpeg.yt.dlp.for.slides.and.tesseract.for.slides.ocr"))}\n`,
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
  const t = createCliTranslator(locale);
  const styled = createCliTranslator(locale, {
    uiLabel: theme.label,
    uiDetail: theme.dim,
    default: theme.label,
  });
  const oscProgress = createOscProgressController({
    label: t("fetching.website"),
    env: io.env,
    isTty: flags.progressEnabled,
    write: (data: string) => io.stderr.write(data),
  });
  oscProgress.setIndeterminate(t("fetching.website"));
  const spinner = startSpinner({
    text: theme.label(t("progress.fetchStart")),
    enabled: flags.progressEnabled,
    stream: io.stderr,
    color: theme.palette.spinner,
  });
  const styleLabel = (text: string) => theme.label(text);
  const styleDim = (text: string) => theme.dim(text);
  const renderStatus = (key: CliMessageKey) => styled(key, { hasMeta: false, meta: "" });
  const renderStatusWithMeta = (key: CliMessageKey, meta: string) =>
    styled(key, { meta, hasMeta: Boolean(meta) });
  const renderStatusFromText = (text: string) => styleLabel(text);
  const progressStatus = createUrlProgressStatus({
    locale,
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
          onSlidesProgress: (text: string, message?: CliMessage) => {
            // Public legacy callbacks only carried text; keep their OSC percentage working.
            const legacyPercent = text.match(/\b(\d+(?:\.\d+)?)%/u)?.[1];
            const percent =
              typeof message?.values.percent === "number"
                ? message.values.percent * 100
                : legacyPercent
                  ? Number(legacyPercent)
                  : null;
            progressStatus.setSlides(
              message ? styled(message.key, message.values) : renderStatusFromText(text),
              Number.isFinite(percent) && percent !== null ? percent : null,
            );
          },
        })
      : hooks;
  const websiteProgress = createWebsiteProgress({
    locale,
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

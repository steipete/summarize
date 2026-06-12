import { promises as fs } from "node:fs";
import {
  buildTimestampUrl,
  formatOsc8Link,
  formatTimestamp,
} from "@steipete/summarize-core/slides";
import type { SlideExtractionResult } from "../../../slides/index.js";
import type { SlideState } from "./slides-output-state.js";

export function createInlineSlidesUnsupportedNotifier({
  inlineNoticeEnabled,
  flags,
  io,
  richTty,
  clearProgressForStdout,
  restoreProgressAfterStdout,
}: {
  inlineNoticeEnabled: boolean;
  flags: { plain: boolean };
  io: {
    stderr: NodeJS.WritableStream;
  };
  richTty: boolean;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
}) {
  let inlineNoticeShown = false;

  return (nextSlides: SlideExtractionResult) => {
    if (!inlineNoticeEnabled || inlineNoticeShown) return;
    if (!nextSlides.slidesDir) return;
    inlineNoticeShown = true;
    const reason = richTty ? "terminal does not support inline images" : "stdout is not a TTY";
    clearProgressForStdout();
    io.stderr.write(
      `Slides saved to ${nextSlides.slidesDir}. Inline images unavailable (${reason}).\n`,
    );
    const urlArg = JSON.stringify(nextSlides.sourceUrl);
    const dirArg = JSON.stringify(nextSlides.slidesDir);
    io.stderr.write(`Use summarize slides ${urlArg} --output ${dirArg} to export only.\n`);
    restoreProgressAfterStdout?.();
  };
}

export function createSlidesTerminalRenderer({
  io,
  flags,
  inlineEnabled,
  richTty,
  inlineRenderer,
  labelTheme,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  onProgressText,
  getOrder,
  getSlide,
  getSourceUrl,
  waitForSlide,
  initialSlides,
}: {
  io: { stdout: NodeJS.WritableStream };
  flags: { slidesDebug?: boolean };
  inlineEnabled: boolean;
  richTty: boolean;
  inlineRenderer: {
    renderSlide: (
      slide: { index: number; timestamp: number; imagePath: string },
      title?: string | null,
    ) => Promise<boolean>;
  } | null;
  labelTheme: { dim: (text: string) => string; heading: (text: string) => string };
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
  onProgressText?: ((text: string) => void) | null;
  getOrder: () => number[];
  getSlide: (index: number) => SlideState | null;
  getSourceUrl: () => string;
  waitForSlide: (index: number) => Promise<SlideState | null>;
  initialSlides: SlideExtractionResult | null | undefined;
}) {
  let renderedCount = 0;

  return async (index: number, title?: string | null) => {
    if (index <= 0) return;
    const total = getOrder().length || (initialSlides?.slides.length ?? 0);
    const slide = getSlide(index);
    let imagePath = slide?.imagePath ?? null;
    if (inlineEnabled) {
      const ready = await waitForSlide(index);
      imagePath = ready?.imagePath ?? imagePath;
    }
    const timestamp = slide?.timestamp;
    const timestampLabel =
      typeof timestamp === "number" && Number.isFinite(timestamp)
        ? formatTimestamp(timestamp)
        : null;
    const timestampUrl =
      typeof timestamp === "number" && Number.isFinite(timestamp)
        ? buildTimestampUrl(getSourceUrl(), timestamp)
        : null;
    const timeLink = timestampLabel ? formatOsc8Link(timestampLabel, timestampUrl, richTty) : null;
    const slideLabelBase = total > 0 ? `Slide ${index}/${total}` : `Slide ${index}`;
    const rawLabel = [slideLabelBase, timeLink].filter(Boolean).join(" · ");
    const label = labelTheme.dim(rawLabel);
    const cleanTitle = title?.replace(/\s+/g, " ").trim() ?? "";
    const titleMax = 90;
    const shortTitle =
      cleanTitle.length > titleMax
        ? `${cleanTitle.slice(0, titleMax - 3).trimEnd()}...`
        : cleanTitle;
    const titleLine = shortTitle ? labelTheme.heading(shortTitle) : "";
    const headerLine = shortTitle
      ? `${titleLine}${timeLink ? ` ${labelTheme.dim(`· ${timeLink}`)}` : ""}`
      : label;

    clearProgressForStdout();
    io.stdout.write("\n");
    if (inlineEnabled && imagePath && inlineRenderer && !flags.slidesDebug) {
      await inlineRenderer.renderSlide({ index, timestamp: timestamp ?? 0, imagePath }, null);
    }
    if (flags.slidesDebug) {
      let resolvedPath = imagePath ?? "(missing image path)";
      if (imagePath) {
        const exists = await fs
          .stat(imagePath)
          .then(() => true)
          .catch(() => false);
        resolvedPath = exists ? imagePath : `${imagePath} (missing)`;
      }
      io.stdout.write(`${headerLine}\n${resolvedPath}\n\n`);
    } else {
      io.stdout.write(`${headerLine}\n\n`);
    }
    restoreProgressAfterStdout?.();

    if (onProgressText && total > 0) {
      renderedCount = Math.min(total, renderedCount + 1);
      onProgressText(`Slides ${renderedCount}/${total}`);
    }
  };
}

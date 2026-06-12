import { createSlidesPresentationStream } from "@steipete/summarize-core/slides";
import { createMarkdownStreamer, render as renderMarkdownAnsi } from "markdansi";
import { prepareMarkdownForTerminalStreaming } from "../../markdown.js";
import { createStreamOutputGate, type StreamOutputMode } from "../../stream-output.js";
import type { SummaryStreamHandler } from "../../summary-engine.js";
import { isRichTty, markdownRenderWidth, supportsColor } from "../../terminal.js";

export function createSlidesSummaryStreamHandler({
  stdout,
  env,
  envForRun,
  plain,
  outputMode,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  renderSlide,
  getSlideIndexOrder,
  getSlideMeta,
  debugWrite,
}: {
  stdout: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  plain: boolean;
  outputMode: StreamOutputMode;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
  renderSlide: (index: number, title?: string | null) => Promise<void>;
  getSlideIndexOrder: () => number[];
  getSlideMeta?: ((index: number) => { total: number; timestamp: number | null }) | null;
  debugWrite?: ((text: string) => void) | null;
}): SummaryStreamHandler {
  const shouldRenderMarkdown = !plain && isRichTty(stdout);
  const outputGate = !shouldRenderMarkdown
    ? createStreamOutputGate({
        stdout,
        clearProgressForStdout,
        restoreProgressAfterStdout: restoreProgressAfterStdout ?? null,
        outputMode,
        richTty: isRichTty(stdout),
      })
    : null;
  const streamer = shouldRenderMarkdown
    ? createMarkdownStreamer({
        render: (markdown) =>
          renderMarkdownAnsi(prepareMarkdownForTerminalStreaming(markdown), {
            width: markdownRenderWidth(stdout, env),
            wrap: true,
            color: supportsColor(stdout, envForRun),
            hyperlinks: true,
          }),
        spacing: "single",
      })
    : null;

  let wroteLeadingBlankLine = false;
  let visible = "";

  const handleMarkdownChunk = (nextVisible: string, prevVisible: string) => {
    if (!streamer) return;
    const appended = nextVisible.slice(prevVisible.length);
    if (!appended) return;
    const out = streamer.push(appended);
    if (!out) return;
    clearProgressForStdout();
    if (!wroteLeadingBlankLine) {
      stdout.write(`\n${out.replace(/^\n+/, "")}`);
      wroteLeadingBlankLine = true;
    } else {
      stdout.write(out);
    }
    restoreProgressAfterStdout?.();
  };

  const pushVisible = (segment: string) => {
    if (!segment) return;
    const prevVisible = visible;
    visible += segment;
    if (outputGate) {
      outputGate.handleChunk(visible, prevVisible);
      return;
    }
    handleMarkdownChunk(visible, prevVisible);
  };

  const pushVisibleLines = (segment: string) => {
    if (!segment) return;
    const parts = segment.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      const line = (parts[i] ?? "").replace(/^#{1,6}\s+/, "");
      const suffix = i < parts.length - 1 ? "\n" : "";
      if (!line && !suffix) continue;
      pushVisible(`${line}${suffix}`);
    }
  };

  const stream = createSlidesPresentationStream({
    getSlideIndexOrder,
    getSlideMeta,
    debugWrite,
    onSlide: renderSlide,
    onText: (segment, kind) => {
      if (kind === "slide-body") {
        pushVisibleLines(segment);
        return;
      }
      pushVisible(segment);
    },
  });

  return {
    onChunk: async ({ appended }) => {
      await stream.push(appended);
    },
    onDone: async () => {
      await stream.finish();
      if (outputGate) {
        outputGate.finalize(visible);
        return;
      }
      const out = streamer?.finish();
      if (out) {
        clearProgressForStdout();
        if (!wroteLeadingBlankLine) {
          stdout.write(`\n${out.replace(/^\n+/, "")}`);
          wroteLeadingBlankLine = true;
        } else {
          stdout.write(out);
        }
        restoreProgressAfterStdout?.();
      } else if (visible && !wroteLeadingBlankLine) {
        clearProgressForStdout();
        stdout.write(`\n${visible.trim()}\n`);
        restoreProgressAfterStdout?.();
      }
    },
  };
}

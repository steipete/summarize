import { createSlidesPresentationStream } from "@steipete/summarize-core/slides";
import type { SummaryStreamHandler } from "../../../engine/events.js";
import { createTerminalMarkdownStreamer } from "../../markdown-streamer.js";
import { createStreamOutputGate, type StreamOutputMode } from "../../stream-output.js";
import { isRichTty } from "../../terminal.js";

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
  const createStreamer = () =>
    shouldRenderMarkdown ? createTerminalMarkdownStreamer({ stdout, env, envForRun }) : null;
  let streamer = createStreamer();

  let wroteLeadingBlankLine = false;
  let visible = "";
  let emittedInChunk = false;

  const handleMarkdownChunk = (nextVisible: string, prevVisible: string) => {
    if (!streamer) return false;
    const appended = nextVisible.slice(prevVisible.length);
    if (!appended) return false;
    const out = streamer.push(appended);
    if (!out) return false;
    clearProgressForStdout();
    if (!wroteLeadingBlankLine) {
      stdout.write(`\n${out.replace(/^\n+/, "")}`);
      wroteLeadingBlankLine = true;
    } else {
      stdout.write(out);
    }
    restoreProgressAfterStdout?.();
    return true;
  };

  const pushVisible = (segment: string) => {
    if (!segment) return;
    const prevVisible = visible;
    visible += segment;
    if (outputGate) {
      emittedInChunk = outputGate.handleChunk(visible, prevVisible) || emittedInChunk;
      return;
    }
    emittedInChunk = handleMarkdownChunk(visible, prevVisible) || emittedInChunk;
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

  const createStream = () =>
    createSlidesPresentationStream({
      getSlideIndexOrder,
      getSlideMeta,
      debugWrite,
      onSlide: async (index, title) => {
        await renderSlide(index, title);
        emittedInChunk = true;
      },
      onText: (segment, kind) => {
        if (kind === "slide-body") {
          pushVisibleLines(segment);
          return;
        }
        pushVisible(segment);
      },
    });
  let stream = createStream();

  return {
    onChunk: async ({ appended }) => {
      emittedInChunk = false;
      await stream.push(appended);
      return emittedInChunk;
    },
    onDone: async () => {
      emittedInChunk = false;
      await stream.finish();
      let emitted = emittedInChunk;
      if (outputGate) {
        return outputGate.finalize(visible) || emitted;
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
        emitted = true;
      } else if (visible && !wroteLeadingBlankLine) {
        clearProgressForStdout();
        stdout.write(`\n${visible.trim()}\n`);
        restoreProgressAfterStdout?.();
        emitted = true;
      }
      return emitted;
    },
    onReset: () => {
      outputGate?.reset();
      streamer = createStreamer();
      wroteLeadingBlankLine = false;
      visible = "";
      emittedInChunk = false;
      stream = createStream();
    },
  };
}

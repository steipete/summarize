import type { SummaryStreamHandler } from "../engine/events.js";
import { createTerminalMarkdownStreamer } from "./markdown-streamer.js";
import { createStreamOutputGate, type StreamOutputMode } from "./stream-output.js";
import { isRichTty } from "./terminal.js";

export function createTerminalSummaryStream({
  stdout,
  env,
  envForRun,
  plain,
  outputMode,
  clearProgressForStdout,
  restoreProgressAfterStdout,
}: {
  stdout: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  plain: boolean;
  outputMode?: StreamOutputMode | null;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
}): SummaryStreamHandler {
  const richTty = isRichTty(stdout);
  const shouldRenderMarkdown = !plain && richTty;
  const resolvedOutputMode = outputMode ?? (richTty ? "delta" : "line");
  const outputGate = shouldRenderMarkdown
    ? null
    : createStreamOutputGate({
        stdout,
        clearProgressForStdout,
        restoreProgressAfterStdout:
          resolvedOutputMode === "delta" ? null : (restoreProgressAfterStdout ?? null),
        outputMode: resolvedOutputMode,
        richTty: richTty && resolvedOutputMode === "line",
        rewriteOnReplacement: richTty && resolvedOutputMode === "delta",
        restoreDuringStream: resolvedOutputMode !== "delta",
      });
  const createStreamer = () =>
    shouldRenderMarkdown ? createTerminalMarkdownStreamer({ stdout, env, envForRun }) : null;
  let streamer = createStreamer();
  let wroteLeadingBlankLine = false;

  const writeRendered = (text: string) => {
    if (!text) return false;
    clearProgressForStdout();
    if (!wroteLeadingBlankLine) {
      stdout.write(`\n${text.replace(/^\n+/, "")}`);
      wroteLeadingBlankLine = true;
    } else {
      stdout.write(text);
    }
    restoreProgressAfterStdout?.();
    return true;
  };

  return {
    onChunk: ({ streamed, prevStreamed, appended }) => {
      if (outputGate) {
        return outputGate.handleChunk(streamed, prevStreamed);
      }
      return writeRendered(streamer?.push(appended) ?? "");
    },
    onDone: (finalText) => {
      if (outputGate) {
        const emitted = outputGate.finalize(finalText);
        if (resolvedOutputMode === "delta") restoreProgressAfterStdout?.();
        return emitted;
      }
      return writeRendered(streamer?.finish() ?? "");
    },
    onReset: () => {
      outputGate?.reset();
      streamer = createStreamer();
      wroteLeadingBlankLine = false;
    },
  };
}

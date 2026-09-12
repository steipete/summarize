import { createMarkdownStreamer, render as renderMarkdownAnsi } from "markdansi";
import { prepareMarkdownForTerminalStreaming } from "./markdown.js";
import { markdownRenderWidth, supportsColor } from "./terminal.js";

export function createTerminalMarkdownStreamer({
  stdout,
  env,
  envForRun,
}: {
  stdout: NodeJS.WritableStream;
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
}): ReturnType<typeof createMarkdownStreamer> {
  return createMarkdownStreamer({
    render: (markdown) =>
      renderMarkdownAnsi(prepareMarkdownForTerminalStreaming(markdown), {
        width: markdownRenderWidth(stdout, env),
        wrap: true,
        color: supportsColor(stdout, envForRun),
        hyperlinks: true,
      }),
    spacing: "single",
  });
}

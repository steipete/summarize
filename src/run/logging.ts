import { formatLlmRetryNotice } from "../llm/generate-text-shared.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
import { VERBOSE_PREFIX } from "./constants.js";
import { ansi } from "./terminal.js";

export function writeVerbose(
  stderr: NodeJS.WritableStream,
  verbose: boolean,
  message: string,
  color: boolean,
  env?: Record<string, string | undefined>,
): void {
  if (!verbose) {
    return;
  }
  const theme =
    env && color
      ? createThemeRenderer({
          themeName: resolveThemeNameFromSources({ env: env.SUMMARIZE_THEME }),
          enabled: color,
          trueColor: resolveTrueColor(env),
        })
      : null;
  const prefix = theme ? theme.accent(VERBOSE_PREFIX) : ansi("36", VERBOSE_PREFIX, color);
  stderr.write(`${prefix} ${message}\n`);
}

export function createRetryLogger({
  stderr,
  verbose,
  color,
  modelId,
  env,
}: {
  stderr: NodeJS.WritableStream;
  verbose: boolean;
  color: boolean;
  modelId: string;
  env?: Record<string, string | undefined>;
}) {
  return (notice: Parameters<typeof formatLlmRetryNotice>[1]) => {
    writeVerbose(stderr, verbose, formatLlmRetryNotice(modelId, notice), color, env);
  };
}

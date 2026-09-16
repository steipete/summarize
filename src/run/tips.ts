import { CliError } from "../locale.js";
import { hasUvxCli } from "./env.js";

export function withUvxTip(error: unknown, env: Record<string, string | undefined>): Error {
  if (hasUvxCli(env)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new CliError(
    "error.withUvxTip",
    {
      message:
        error instanceof CliError
          ? error.descriptor()
          : error instanceof Error
            ? error.message
            : String(error),
    },
    error instanceof Error ? { cause: error } : undefined,
  );
}

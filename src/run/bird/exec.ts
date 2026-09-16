import { CliError } from "../../locale.js";
import { execFileTracked } from "../../processes.js";

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

export function execTweetCli(
  binary: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string | undefined>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const toText = (value: string | Buffer | null | undefined) =>
      typeof value === "string" ? value : value ? value.toString("utf8") : "";

    execFileTracked(
      binary,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const stdoutText = toText(stdout).trim();
        const stderrText = stripAnsi(toText(stderr)).trim();
        if (error) {
          const detail = stderrText || stdoutText;
          const suffix = detail ? `: ${detail}` : "";
          reject(
            new CliError("error.tweetRead", { binary: String(binary), suffix: String(suffix) }),
          );
          return;
        }
        resolve(stdoutText);
      },
    );
  });
}

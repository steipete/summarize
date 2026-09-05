import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DaemonCommandResult = { stdout: string; stderr: string; code: number };

export async function execDaemonCommand(
  file: string,
  args: string[],
  options: { windowsHide?: boolean } = {},
): Promise<DaemonCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8", ...options });
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr:
        typeof failure.stderr === "string"
          ? failure.stderr
          : typeof failure.message === "string"
            ? failure.message
            : "",
      code: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface EmscriptenExitStatus {
  name?: string;
  status?: number;
}

type EmscriptenModuleFactory = (options: Record<string, unknown>) => Promise<unknown>;

const tool = process.argv[2];
const distDir = process.argv[3];
const args = process.argv.slice(4);
if ((tool !== "ffmpeg" && tool !== "ffprobe") || !distDir) {
  process.stderr.write("usage: run-generated <ffmpeg|ffprobe> <dist-dir> [...args]\n");
  process.exit(64);
}

let exitCode = 0;
let resolveExit!: () => void;
const exited = new Promise<void>((resolvePromise) => {
  resolveExit = resolvePromise;
});

try {
  const jsPath = resolve(distDir, `${tool}.js`);
  const imported: unknown = await import(pathToFileURL(jsPath).href);
  const createModule = getDefaultFactory(imported);
  if (!createModule) {
    throw new Error(`Invalid Emscripten module: ${jsPath}`);
  }

  const module = createModule({
    arguments: args,
    thisProgram: tool,
    locateFile: (name: string) => resolve(distDir, name),
    print: (line: string) => process.stdout.write(`${line}\n`),
    printErr: (line: string) => process.stderr.write(`${line}\n`),
    onExit: (code: number) => {
      exitCode = code;
      resolveExit();
    },
  });

  await Promise.race([
    exited,
    module.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => {
        if (isExitStatus(error)) {
          exitCode =
            typeof error.status === "number" ? error.status : (parseExitStatus(error) ?? exitCode);
          resolveExit();
          return new Promise<never>(() => {});
        }
        throw error;
      },
    ),
  ]);
  process.exit(exitCode);
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
}

function getDefaultFactory(value: unknown): EmscriptenModuleFactory | undefined {
  if (value === null || value === undefined || typeof value !== "object" || !("default" in value)) {
    return undefined;
  }
  const maybeFactory: unknown = Reflect.get(value, "default");
  return typeof maybeFactory === "function" ? (maybeFactory as EmscriptenModuleFactory) : undefined;
}

function isExitStatus(error: unknown): error is EmscriptenExitStatus {
  const text = formatError(error);
  return (
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "ExitStatus") ||
    text.startsWith("Program terminated with exit(")
  );
}

function parseExitStatus(error: EmscriptenExitStatus) {
  const match = /exit\((?<status>\d+)\)/u.exec(formatError(error));
  const status = match?.groups?.status;
  return status === undefined ? undefined : Number(status);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

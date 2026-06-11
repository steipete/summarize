#!/usr/bin/env node
import { runCliMain } from "./cli-main.js";

void runCliMain({
  argv: process.argv.slice(2),
  env: process.env,
  fetch: globalThis.fetch,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
  setExitCode: (code) => {
    process.exitCode = code;
  },
}).catch((error) => {
  // Last-resort fallback; runCliMain should already format errors nicely.
  const message = error instanceof Error ? error.message : error ? String(error) : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

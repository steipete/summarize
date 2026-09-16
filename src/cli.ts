#!/usr/bin/env node
import { runCliMain } from "./cli-main.js";
import { cliErrorText, resolveCliLocaleFromArgs } from "./locale.js";

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
  const message = cliErrorText(error, resolveCliLocaleFromArgs(process.argv.slice(2), process.env));
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

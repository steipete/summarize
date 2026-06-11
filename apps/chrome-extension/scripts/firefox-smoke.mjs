import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(appDir, ".output", "firefox-mv3");
const startupTimeoutMs = 45_000;
const readyHoldMs = 3_000;

if (!fs.existsSync(path.join(sourceDir, "manifest.json"))) {
  throw new Error("Missing Firefox extension build. Run pnpm build:firefox first.");
}

const firefoxBinary = await resolveFirefoxBinary();
if (!firefoxBinary) {
  throw new Error(
    "Firefox binary not found. Install Firefox, run Playwright's Firefox install, or set FIREFOX_BINARY.",
  );
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = [
  "exec",
  "web-ext",
  "run",
  "--source-dir",
  sourceDir,
  "--firefox",
  firefoxBinary,
  "--no-reload",
  "--no-input",
  "--start-url",
  "about:blank",
  "--args=-headless",
  "--pref=browser.shell.checkDefaultBrowser=false",
  "--pref=datareporting.policy.dataSubmissionEnabled=false",
];
const child = spawn(pnpm, args, {
  cwd: appDir,
  env: { ...process.env, NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
let ready = false;
let settled = false;
let startupTimer;
let holdTimer;

const finish = (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(startupTimer);
  clearTimeout(holdTimer);
  if (!child.killed) child.kill("SIGINT");
  if (error) {
    console.error(output.trim());
    process.exitCode = 1;
    console.error(error.message);
  }
};

const onOutput = (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (
    !ready &&
    /extension will reload|installed .*temporary|running web extension|launching firefox/i.test(
      output,
    )
  ) {
    ready = true;
    holdTimer = setTimeout(() => finish(), readyHoldMs);
  }
};

child.stdout.on("data", onOutput);
child.stderr.on("data", onOutput);
child.once("error", (error) => finish(error));
child.once("exit", (code, signal) => {
  if (settled) return;
  if (ready && (code === 0 || code === null || signal === "SIGINT")) {
    finish();
    return;
  }
  finish(
    new Error(`Firefox extension smoke exited before startup (code=${code}, signal=${signal}).`),
  );
});

startupTimer = setTimeout(
  () => finish(new Error(`Firefox extension smoke did not start within ${startupTimeoutMs}ms.`)),
  startupTimeoutMs,
);

await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (!settled) return;
    clearInterval(poll);
    resolve();
  }, 50);
});

async function resolveFirefoxBinary() {
  const configured = process.env.FIREFOX_BINARY?.trim();
  if (configured && fs.existsSync(configured)) return configured;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Firefox.app/Contents/MacOS/firefox",
          "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
          path.join(process.env.HOME ?? "", "Applications/Firefox.app/Contents/MacOS/firefox"),
        ]
      : process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES ?? "", "Mozilla Firefox", "firefox.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Mozilla Firefox", "firefox.exe"),
          ]
        : ["/usr/bin/firefox", "/usr/bin/firefox-esr"];
  const installed = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (installed) return installed;

  const command = process.platform === "win32" ? "where" : "which";
  const discovered = spawnSync(command, ["firefox"], { encoding: "utf8" });
  const commandPath = discovered.status === 0 ? discovered.stdout.trim().split(/\r?\n/)[0] : "";
  if (commandPath && fs.existsSync(commandPath)) return commandPath;

  try {
    const { firefox } = await import("@playwright/test");
    const playwrightPath = firefox.executablePath();
    return fs.existsSync(playwrightPath) ? playwrightPath : null;
  } catch {
    return null;
  }
}

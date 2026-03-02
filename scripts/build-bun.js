#!/usr/bin/env bun
//
// build-bun.js
// summarize
//

// Don't use Bun shell ($) as it breaks bytecode compilation.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const distDir = join(projectRoot, "dist-bun");
const require = createRequire(import.meta.url);
const MAC_TARGETS = [
  { arch: "arm64", target: "bun-darwin-arm64", outName: "summarize" },
  { arch: "x64", target: "bun-darwin-x64", outName: "summarize-x64" },
];

function run(cmd, args, opts = {}) {
  const printable = [cmd, ...args].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ");
  console.log(`+ ${printable}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} failed with exit code ${result.status}`);
  }
}

function runCaptureAsync(cmd, args, opts = {}) {
  const printable = [cmd, ...args].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ");
  console.log(`+ ${printable}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? 0, stdout, stderr });
    });
  });
}

function readPackageVersion() {
  const pkg = require(join(projectRoot, "package.json"));
  return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
}

function readGitSha() {
  const result = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function chmodX(path) {
  run("chmod", ["+x", path]);
}

function buildOne({ target, outName, version, gitSha }) {
  const outPath = join(distDir, outName);
  console.log(`\n🔨 Building ${outName} (target=${target}, bytecode)…`);
  if (version) process.env.SUMMARIZE_VERSION = version;
  if (gitSha) process.env.SUMMARIZE_GIT_SHA = gitSha;
  run("bun", [
    "build",
    join(projectRoot, "src/cli.ts"),
    "--compile",
    "--bytecode",
    "--minify",
    "--target",
    target,
    "--env=SUMMARIZE_*",
    "--outfile",
    outPath,
  ]);
  chmodX(outPath);

  try {
    const st = statSync(outPath);
    const size = fmtSize(st.size);
    console.log(`✅ Built ${outName}${size ? ` (${size})` : ""}`);
  } catch {
    console.log(`✅ Built ${outName}`);
  }

  return outPath;
}

function packageTarball({ binaryPath, version, arch }) {
  const stageDir = mkdtempSync(join(tmpdir(), `summarize-bun-${arch}-`));
  const stagedBinary = join(stageDir, "summarize");
  copyFileSync(binaryPath, stagedBinary);
  chmodX(stagedBinary);

  const tarName = `summarize-macos-${arch}-v${version}.tar.gz`;
  const tarPath = join(distDir, tarName);
  console.log(`\n📦 Packaging tarball (${arch})…`);
  run("tar", ["-czf", tarPath, "-C", stageDir, "summarize"]);
  return tarPath;
}

function buildMacosTargets({ version }) {
  const gitSha = readGitSha();
  const builds = {};

  for (const { arch, target, outName } of MAC_TARGETS) {
    const binary = buildOne({ target, outName, version, gitSha });
    const tarPath = packageTarball({ binaryPath: binary, version, arch });
    builds[arch] = { binary, tarPath };
  }

  console.log("\n🔐 sha256:");
  for (const { arch } of MAC_TARGETS) {
    run("shasum", ["-a", "256", builds[arch].tarPath]);
  }

  return builds;
}

async function runE2E(binary) {
  if (!globalThis.Bun?.serve) {
    throw new Error("Bun runtime missing; run with bun.");
  }

  console.log("\n🧪 Bun E2E…");
  const html = "<!doctype html><html><body><h1>Hello Bun</h1><p>World</p></body></html>";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  const cacheHome = mkdtempSync(join(tmpdir(), "summarize-bun-e2e-"));

  try {
    const result = await runCaptureAsync(
      binary,
      ["--extract", "--json", "--metrics", "off", "--timeout", "5s", url],
      {
        env: { ...process.env, HOME: cacheHome },
      },
    );
    if (result.status !== 0) {
      throw new Error(`bun e2e failed: ${result.stderr ?? ""}`);
    }
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    let payload = null;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error(`bun e2e invalid json: ${stdout.slice(0, 200)}`);
    }
    const content = payload?.extracted?.content ?? "";
    if (!content.includes("Hello Bun")) {
      throw new Error("bun e2e missing extracted content");
    }
    if (!existsSync(join(cacheHome, ".summarize", "cache.sqlite"))) {
      throw new Error("bun e2e missing cache sqlite");
    }
    console.log("✅ Bun E2E ok");
  } finally {
    server.stop();
  }
}

function pickHostBinary(builds) {
  if (process.arch === "arm64" && builds.arm64) return builds.arm64.binary;
  if (process.arch === "x64" && builds.x64) return builds.x64.binary;
  return builds.arm64?.binary ?? builds.x64?.binary;
}

async function main() {
  console.log("🚀 summarize Bun builder");
  console.log("========================");

  const version = readPackageVersion();

  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  const builds = buildMacosTargets({ version });

  if (process.argv.includes("--test")) {
    const hostBinary = pickHostBinary(builds);
    if (!hostBinary) {
      throw new Error("No compatible binary available for smoke tests.");
    }
    console.log(`\n🧪 Smoke (${process.arch})…`);
    run(hostBinary, ["--version"]);
    run(hostBinary, ["--help"]);
    await runE2E(hostBinary);
  }

  console.log(`\n✨ Done. dist: ${distDir}`);
}

// Performance knobs for bun compile (matches poltergeist pattern).
process.env.BUN_JSC_forceRAMSize = "1073741824";
process.env.BUN_JSC_useJIT = "1";
process.env.BUN_JSC_useBBQJIT = "1";
process.env.BUN_JSC_useDFGJIT = "1";
process.env.BUN_JSC_useFTLJIT = "1";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

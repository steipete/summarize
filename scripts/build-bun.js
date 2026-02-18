#!/usr/bin/env bun
//
// build-bun.js
// summarize
//

// Don't use Bun shell ($) as it breaks bytecode compilation.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const distDir = join(projectRoot, "dist-bun");
const require = createRequire(import.meta.url);

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

function sha256(filePath) {
  // shasum on macOS/BSD, sha256sum on Linux
  if (process.platform === "darwin") {
    run("shasum", ["-a", "256", filePath]);
  } else {
    run("sha256sum", [filePath]);
  }
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

function buildPlatform({ bunTarget, tarName, version }) {
  const gitSha = readGitSha();
  const outPath = buildOne({ target: bunTarget, outName: "summarize", version, gitSha });
  chmodX(outPath);

  const tarPath = join(distDir, tarName);
  console.log("\n📦 Packaging tarball…");
  run("tar", ["-czf", tarPath, "-C", distDir, "summarize"]);

  console.log("\n🔐 sha256:");
  sha256(tarPath);

  return { binary: outPath, tarPath };
}

function buildMacosArm64({ version }) {
  return buildPlatform({
    bunTarget: "bun-darwin-arm64",
    tarName: `summarize-macos-arm64-v${version}.tar.gz`,
    version,
  });
}

function buildLinuxX64({ version }) {
  return buildPlatform({
    bunTarget: "bun-linux-x64",
    tarName: `summarize-linux-x64-v${version}.tar.gz`,
    version,
  });
}

function buildLinuxArm64({ version }) {
  return buildPlatform({
    bunTarget: "bun-linux-arm64",
    tarName: `summarize-linux-arm64-v${version}.tar.gz`,
    version,
  });
}

// Returns the platform string matching the current host.
function detectNativePlatform() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  return null;
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

async function main() {
  console.log("🚀 summarize Bun builder");
  console.log("========================");

  const version = readPackageVersion();
  const args = process.argv.slice(2);
  const runTests = args.includes("--test");
  const buildAll = args.includes("--all");

  // --platform <name> overrides auto-detection; --all builds every platform.
  const platformFlagIdx = args.indexOf("--platform");
  const explicitPlatform = platformFlagIdx !== -1 ? args[platformFlagIdx + 1] : null;

  const nativePlatform = detectNativePlatform();
  const targetPlatform = buildAll ? "all" : (explicitPlatform ?? nativePlatform);

  if (!targetPlatform) {
    throw new Error(
      `Unsupported host ${process.platform}/${process.arch}. Use --platform <macos-arm64|linux-x64|linux-arm64> or --all.`,
    );
  }

  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  const platforms = targetPlatform === "all"
    ? ["macos-arm64", "linux-x64", "linux-arm64"]
    : [targetPlatform];

  // When building all platforms, put the native one last so that
  // dist-bun/summarize ends up as the locally runnable binary for smoke tests.
  if (nativePlatform && platforms.length > 1) {
    const idx = platforms.indexOf(nativePlatform);
    if (idx > -1) {
      platforms.splice(idx, 1);
      platforms.push(nativePlatform);
    }
  }

  const builders = {
    "macos-arm64": buildMacosArm64,
    "linux-x64": buildLinuxX64,
    "linux-arm64": buildLinuxArm64,
  };

  let nativeBinary = null;
  for (const plat of platforms) {
    const build = builders[plat];
    if (!build) throw new Error(`Unknown platform: ${plat}`);
    const { binary } = build({ version });
    if (plat === nativePlatform) nativeBinary = binary;
  }

  if (runTests) {
    const testBinary = nativeBinary ?? (platforms.length === 1 ? join(distDir, "summarize") : null);
    if (!testBinary) {
      console.warn("⚠️  Skipping tests: no native platform binary built (cross-compile only).");
    } else {
      console.log("\n🧪 Smoke…");
      run(testBinary, ["--version"]);
      run(testBinary, ["--help"]);
      await runE2E(testBinary);
    }
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

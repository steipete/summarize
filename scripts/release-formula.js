import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function replaceOnce(input, pattern, replacer) {
  const next = input.replace(pattern, replacer);
  if (next === input) {
    throw new Error(`failed to update formula using pattern: ${pattern}`);
  }
  return next;
}

export function updateFormulaForMacArtifacts(data, { urlArm, shaArm, urlX64, shaX64 }) {
  if (data.includes("on_arm do") && data.includes("on_intel do")) {
    let next = data;
    next = replaceOnce(next, /(on_arm do\s*\n\s*url ")(.*?)(")/s, `$1${urlArm}$3`);
    next = replaceOnce(next, /(on_arm do.*?\n\s*sha256 ")(.*?)(")/s, `$1${shaArm}$3`);
    next = replaceOnce(next, /(on_intel do\s*\n\s*url ")(.*?)(")/s, `$1${urlX64}$3`);
    next = replaceOnce(next, /(on_intel do.*?\n\s*sha256 ")(.*?)(")/s, `$1${shaX64}$3`);
    return next;
  }

  if (data.includes("depends_on arch: :arm64")) {
    const dualBlock = [
      "  on_arm do",
      `    url "${urlArm}"`,
      `    sha256 "${shaArm}"`,
      "  end",
      "",
      "  on_intel do",
      `    url "${urlX64}"`,
      `    sha256 "${shaX64}"`,
      "  end",
    ].join("\n");

    let next = data;
    next = replaceOnce(next, /  url "[^"\n]+"\n  sha256 "[^"\n]+"/, dualBlock);
    next = replaceOnce(next, /^  depends_on arch: :arm64\s*\n?/m, "");
    return next;
  }

  let next = data;
  next = replaceOnce(next, /^  url ".*"$/m, `  url "${urlArm}"`);
  next = replaceOnce(next, /^  sha256 ".*"$/m, `  sha256 "${shaArm}"`);
  return next;
}

export function updateFormulaFile(path, args) {
  const data = readFileSync(path, "utf8");
  writeFileSync(path, updateFormulaForMacArtifacts(data, args));
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  const [, , path, urlArm, shaArm, urlX64, shaX64] = process.argv;
  if (!path || !urlArm || !shaArm || !urlX64 || !shaX64) {
    console.error(
      "Usage: node scripts/release-formula.js <path> <urlArm> <shaArm> <urlX64> <shaX64>",
    );
    process.exit(2);
  }
  updateFormulaFile(path, { urlArm, shaArm, urlX64, shaX64 });
}

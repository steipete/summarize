import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LINUX_HOMEBREW_MESSAGE =
  "summarize Homebrew formula is macOS-only; use npm install -g @steipete/summarize on Linux";

function skipDoBlock(lines, start) {
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.endsWith(" do")) {
      depth += 1;
      continue;
    }
    if (trimmed === "end") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  throw new Error(`failed to find matching end for block starting at line ${start + 1}`);
}

function stripExistingPlatformConfig(data) {
  const lines = data.split("\n");
  const next = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (/^  on_(macos|linux|arm|intel) do$/.test(line)) {
      index = skipDoBlock(lines, index);
      continue;
    }
    if (
      /^  url "[^"\n]+"$/.test(line) ||
      /^  sha256 "[^"\n]+"$/.test(line) ||
      /^  depends_on arch: :arm64$/.test(line) ||
      /^  depends_on :macos$/.test(line) ||
      line === `  # ${LINUX_HOMEBREW_MESSAGE}`
    ) {
      index += 1;
      continue;
    }
    next.push(line);
    index += 1;
  }

  return next;
}

function findPlatformInsertIndex(lines) {
  let insertIndex = 1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^  (desc|homepage|version|license) /.test(lines[index])) {
      insertIndex = index + 1;
      continue;
    }
    if (lines[index].trim() === "") {
      continue;
    }
    break;
  }
  return insertIndex;
}

function buildPlatformBlock({ urlArm, shaArm, urlX64, shaX64 }) {
  return [
    `  # ${LINUX_HOMEBREW_MESSAGE}`,
    "  depends_on :macos",
    "",
    "  on_macos do",
    "    on_arm do",
    `      url "${urlArm}"`,
    `      sha256 "${shaArm}"`,
    "    end",
    "",
    "    on_intel do",
    `      url "${urlX64}"`,
    `      sha256 "${shaX64}"`,
    "    end",
    "  end",
  ];
}

export function updateFormulaForMacArtifacts(data, { urlArm, shaArm, urlX64, shaX64 }) {
  const lines = stripExistingPlatformConfig(data);
  const insertIndex = findPlatformInsertIndex(lines);
  const output = [
    ...lines.slice(0, insertIndex),
    "",
    ...buildPlatformBlock({ urlArm, shaArm, urlX64, shaX64 }),
    "",
    ...lines.slice(insertIndex).filter((line, index, array) => {
      if (line.trim() !== "") return true;
      const previous = index > 0 ? array[index - 1] : "";
      return previous.trim() !== "";
    }),
  ];
  return `${output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
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

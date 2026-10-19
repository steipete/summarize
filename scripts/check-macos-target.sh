#!/usr/bin/env bash
set -euo pipefail

otool -l "$1" | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const blocks = input.split(/Load command \d+/).filter(block => /cmd LC_BUILD_VERSION\b/.test(block));
  const version = blocks[0]?.match(/\bminos (\d+(?:\.\d+){0,2})\b/)?.[1];
  const parts = version?.split(".").map(Number);
  if (blocks.length !== 1 || !/\bplatform (?:1|macos)\b/i.test(blocks[0]) ||
      !parts || parts[0] > 13 || (parts[0] === 13 && parts.slice(1).some(part => part > 0))) {
    console.error(`release binary minimum macOS version ${version ?? "missing"} exceeds macOS 13.0 or is invalid`);
    process.exitCode = 1;
  }
});
'

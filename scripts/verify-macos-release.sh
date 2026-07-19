#!/usr/bin/env bash
set -euo pipefail

ARCHIVE=${1:-}
EXPECTED_ARCH=${2:-}
EXPECTED_VERSION=${3:-}
IDENTIFIER=com.steipete.summarize.cli
TEAM_ID=Y5PE65HELJ
EXPECTED_AUTHORITY="Developer ID Application: Peter Steinberger ($TEAM_ID)"
REQUIREMENT="identifier \"$IDENTIFIER\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM_ID\""

if [[ ! -f "$ARCHIVE" || ! "$EXPECTED_ARCH" =~ ^(arm64|x86_64)$ ||
  ! "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 archive.tar.gz arm64|x86_64 version" >&2
  exit 2
fi
[[ "$(uname -s)" == Darwin ]] || {
  echo "macOS release verification requires a native macOS host" >&2
  exit 1
}
for secret_name in MACOS_SIGNING_P12 MACOS_SIGNING_P12_PASSWORD ASC_KEY_ID ASC_ISSUER_ID ASC_PRIVATE_KEY_P8 CODESIGN_IDENTITY CODESIGN_KEYCHAIN ASC_PRIVATE_KEY_PATH; do
  [[ -z "${!secret_name+x}" ]] || {
    echo "release verification must not receive signing secret $secret_name" >&2
    exit 1
  }
done
for tool in codesign csreq lipo mktemp plutil tar; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing required command: $tool" >&2
    exit 1
  }
done

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/summarize-verify.XXXXXX")
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

entries=$(tar -tzf "$ARCHIVE")
grep -Fxq summarize <<<"$entries" || {
  echo "release archive does not contain summarize at its root" >&2
  exit 1
}
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$entries"; then
  echo "release archive contains an unsafe path" >&2
  exit 1
fi
if tar -tvzf "$ARCHIVE" | awk '$1 !~ /^[-d]/ { exit 1 }'; then
  :
else
  echo "release archive contains a link or unsupported entry type" >&2
  exit 1
fi
tar -xzf "$ARCHIVE" -C "$WORK_DIR"
BINARY="$WORK_DIR/summarize"
[[ -f "$BINARY" && ! -L "$BINARY" && -x "$BINARY" ]] || {
  echo "release archive summarize is not a regular executable" >&2
  exit 1
}

actual_arch=$(lipo -archs "$BINARY" | tr -d '[:space:]')
[[ "$actual_arch" == "$EXPECTED_ARCH" ]] || {
  echo "release binary architecture is $actual_arch, expected $EXPECTED_ARCH" >&2
  exit 1
}

signature=$(codesign -dvvv "$BINARY" 2>&1)
grep -Fqx "Identifier=$IDENTIFIER" <<<"$signature"
grep -Fqx "Authority=$EXPECTED_AUTHORITY" <<<"$signature"
grep -Fqx "TeamIdentifier=$TEAM_ID" <<<"$signature"
grep -Eq '^CodeDirectory .*flags=.*\([^)]*runtime[^)]*\)' <<<"$signature"
grep -Eq '^Timestamp=.+$' <<<"$signature"

embedded_requirement=$(codesign -d -r- "$BINARY" 2>&1)
embedded_source=$(sed -n 's/^designated => //p' <<<"$embedded_requirement")
[[ -n "$embedded_source" && "$embedded_source" != *$'\n'* ]] || {
  echo "release binary does not contain exactly one designated requirement" >&2
  exit 1
}
expected_canonical=$(csreq -r "=$REQUIREMENT" -t)
embedded_canonical=$(csreq -r "=$embedded_source" -t)
[[ "$embedded_canonical" == "$expected_canonical" ]] || {
  echo "release binary designated requirement does not match policy" >&2
  exit 1
}
codesign --verify --strict -R="$REQUIREMENT" --verbose=2 "$BINARY"
codesign --verify --strict --check-notarization -R=notarized --verbose=2 "$BINARY"

embedded_entitlements="$WORK_DIR/embedded-entitlements.plist"
codesign -d --entitlements :- "$BINARY" >"$embedded_entitlements" 2>/dev/null
plutil -lint "$embedded_entitlements" >/dev/null
node - "$embedded_entitlements" <<'NODE'
const { execFileSync } = require("node:child_process");
const file = process.argv[2];
const json = execFileSync("plutil", ["-convert", "json", "-o", "-", file], {
  encoding: "utf8",
});
const entitlements = JSON.parse(json);
const expected = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
];
const actual = Object.keys(entitlements).sort();
if (
  JSON.stringify(actual) !== JSON.stringify(expected) ||
  expected.some((key) => entitlements[key] !== true)
) {
  throw new Error(`unexpected embedded entitlements: ${actual.join(", ")}`);
}
NODE

version_output=$(env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$BINARY" --version)
if [[ "$version_output" != "$EXPECTED_VERSION" &&
  ! "$version_output" =~ ^${EXPECTED_VERSION//./\.}[[:space:]]+\([0-9a-f]{8}\)$ ]]; then
  echo "release binary reports $version_output, expected $EXPECTED_VERSION" >&2
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BINARY=${1:-}
ARCH=${2:-}
OFFICIAL_RELEASE=${SUMMARIZE_OFFICIAL_RELEASE:-0}
IDENTIFIER=com.steipete.summarize.cli
TEAM_ID=Y5PE65HELJ
EXPECTED_AUTHORITY="Developer ID Application: Peter Steinberger ($TEAM_ID)"
ENTITLEMENTS="$ROOT/scripts/macos-release.entitlements"
REQUIREMENT="identifier \"$IDENTIFIER\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$TEAM_ID\""

[[ "$OFFICIAL_RELEASE" == 0 || "$OFFICIAL_RELEASE" == 1 ]] || {
  echo "SUMMARIZE_OFFICIAL_RELEASE must be 0 or 1" >&2
  exit 2
}
[[ "$OFFICIAL_RELEASE" == 1 ]] || exit 0
[[ -f "$BINARY" && ! -L "$BINARY" && "$ARCH" =~ ^(arm64|x64)$ ]] || {
  echo "usage: SUMMARIZE_OFFICIAL_RELEASE=1 $0 binary arm64|x64" >&2
  exit 2
}
[[ "$(uname -s)" == Darwin ]] || {
  echo "official macOS release signing must run on macOS" >&2
  exit 1
}
[[ "${CODESIGN_IDENTITY:-}" == "$EXPECTED_AUTHORITY" ]] || {
  echo "official macOS releases require $EXPECTED_AUTHORITY" >&2
  exit 1
}
[[ -n "${CODESIGN_KEYCHAIN:-}" && -f "$CODESIGN_KEYCHAIN" ]] || {
  echo "CODESIGN_KEYCHAIN must name the CI release keychain" >&2
  exit 1
}
[[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]] || {
  echo "ASC_KEY_ID and ASC_ISSUER_ID are required" >&2
  exit 1
}
[[ -n "${ASC_PRIVATE_KEY_PATH:-}" && -f "$ASC_PRIVATE_KEY_PATH" ]] || {
  echo "ASC_PRIVATE_KEY_PATH must name the App Store Connect private key" >&2
  exit 1
}

for tool in codesign csreq ditto lipo mktemp plutil xcrun; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing required command: $tool" >&2
    exit 1
  }
done
plutil -lint "$ENTITLEMENTS" >/dev/null

EXPECTED_ARCH=$ARCH
[[ "$EXPECTED_ARCH" == x64 ]] && EXPECTED_ARCH=x86_64
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/summarize-notary.XXXXXX")
NOTARY_ARCHIVE="$WORK_DIR/summarize-$ARCH.zip"
NOTARY_RESULT="$WORK_DIR/notary-result.json"
EMBEDDED_ENTITLEMENTS="$WORK_DIR/embedded-entitlements.plist"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

codesign \
  --force \
  --keychain "$CODESIGN_KEYCHAIN" \
  --options runtime \
  --timestamp \
  --identifier "$IDENTIFIER" \
  --requirements "=designated => $REQUIREMENT" \
  --entitlements "$ENTITLEMENTS" \
  --sign "$CODESIGN_IDENTITY" \
  "$BINARY"

codesign --verify --strict -R="$REQUIREMENT" --verbose=2 "$BINARY"
signature=$(codesign -dvvv "$BINARY" 2>&1)
grep -Fqx "Identifier=$IDENTIFIER" <<<"$signature"
grep -Fqx "Authority=$EXPECTED_AUTHORITY" <<<"$signature"
grep -Fqx "TeamIdentifier=$TEAM_ID" <<<"$signature"
grep -Eq '^CodeDirectory .*flags=.*\([^)]*runtime[^)]*\)' <<<"$signature"
grep -Eq '^Timestamp=.+$' <<<"$signature"

embedded_requirement=$(codesign -d -r- "$BINARY" 2>&1)
embedded_source=$(sed -n 's/^designated => //p' <<<"$embedded_requirement")
[[ -n "$embedded_source" && "$embedded_source" != *$'\n'* ]] || {
  echo "signed binary does not contain exactly one designated requirement" >&2
  exit 1
}
expected_canonical=$(csreq -r "=$REQUIREMENT" -t)
embedded_canonical=$(csreq -r "=$embedded_source" -t)
[[ "$embedded_canonical" == "$expected_canonical" ]] || {
  echo "embedded designated requirement does not match the release policy" >&2
  exit 1
}

codesign -d --entitlements :- "$BINARY" >"$EMBEDDED_ENTITLEMENTS" 2>/dev/null
plutil -lint "$EMBEDDED_ENTITLEMENTS" >/dev/null
node - "$EMBEDDED_ENTITLEMENTS" <<'NODE'
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

actual_arch=$(lipo -archs "$BINARY" | tr -d '[:space:]')
[[ "$actual_arch" == "$EXPECTED_ARCH" ]] || {
  echo "signed binary architecture is $actual_arch, expected $EXPECTED_ARCH" >&2
  exit 1
}

ditto -c -k --sequesterRsrc --keepParent "$BINARY" "$NOTARY_ARCHIVE"
xcrun notarytool submit "$NOTARY_ARCHIVE" \
  --key "$ASC_PRIVATE_KEY_PATH" \
  --key-id "$ASC_KEY_ID" \
  --issuer "$ASC_ISSUER_ID" \
  --no-s3-acceleration \
  --wait \
  --output-format json >"$NOTARY_RESULT"
node - "$NOTARY_RESULT" <<'NODE'
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (result.status !== "Accepted") {
  throw new Error(`notarization failed: ${result.status ?? "unknown status"}`);
}
console.log(`Notarization accepted: ${result.id ?? "submission id unavailable"}`);
NODE

notarization_ready=0
for _ in {1..12}; do
  if codesign --verify --strict --check-notarization -R=notarized --verbose=2 "$BINARY"; then
    notarization_ready=1
    break
  fi
  sleep 5
done
[[ "$notarization_ready" == 1 ]] || {
  echo "accepted notarization ticket did not become available online" >&2
  exit 1
}

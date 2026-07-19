#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/summarize-release-test.XXXXXX")
MOCK_BIN="$TEST_DIR/bin"
LOG="$TEST_DIR/commands.log"
mkdir -p "$MOCK_BIN" "$TEST_DIR/stage/ffmpeg-wasm/node"
cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cat >"$MOCK_BIN/uname" <<'EOF'
#!/bin/sh
echo Darwin
EOF

cat >"$MOCK_BIN/lipo" <<'EOF'
#!/bin/sh
echo "${MOCK_ARCH:-arm64}"
EOF

cat >"$MOCK_BIN/codesign" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'codesign %s\n' "$*" >>"$MOCK_LOG"
authority=${MOCK_AUTHORITY:-Developer ID Application: Peter Steinberger (Y5PE65HELJ)}
requirement=${MOCK_REQUIREMENT:-'identifier "com.steipete.summarize.cli" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Y5PE65HELJ'}
case " $* " in
  *' -dvvv '*)
    cat <<META
Executable=test
Identifier=com.steipete.summarize.cli
CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded
Authority=$authority
Timestamp=Jul 18, 2026 at 4:00:00 PM
TeamIdentifier=Y5PE65HELJ
Runtime Version=15.0.0
META
    ;;
  *' -d -r- '*)
    echo "Executable=test"
    echo "designated => $requirement"
    ;;
  *' -d --entitlements :- '*)
    cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
PLIST
    ;;
esac
EOF

cat >"$MOCK_BIN/csreq" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" != -r==* ]] || exit 2
case "$*" in
  *com.steipete.summarize.cli*Y5PE65HELJ*) echo 'canonical release requirement' ;;
  *) echo 'canonical non-policy requirement' ;;
esac
EOF

cat >"$MOCK_BIN/ditto" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'ditto %s\n' "$*" >>"$MOCK_LOG"
output=${!#}
: >"$output"
EOF

cat >"$MOCK_BIN/xcrun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'xcrun %s\n' "$*" >>"$MOCK_LOG"
printf '{"status":"%s","id":"11111111-2222-3333-4444-555555555555"}\n' "${MOCK_NOTARY_STATUS:-Accepted}"
EOF

cat >"$MOCK_BIN/plutil" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == -lint ]]; then
  exit 0
fi
if [[ "$1" == -convert && "$2" == json ]]; then
  printf '%s\n' '{"com.apple.security.cs.allow-jit":true,"com.apple.security.cs.allow-unsigned-executable-memory":true}'
  exit 0
fi
exit 1
EOF

chmod +x "$MOCK_BIN"/*

cat >"$TEST_DIR/stage/summarize" <<'EOF'
#!/bin/sh
echo '0.21.6 (844664f3)'
EOF
chmod +x "$TEST_DIR/stage/summarize"
printf 'runner\n' >"$TEST_DIR/stage/ffmpeg-wasm/run-generated.js"
printf 'wasm\n' >"$TEST_DIR/stage/ffmpeg-wasm/node/ffmpeg_g.wasm"
tar -czf "$TEST_DIR/release.tar.gz" -C "$TEST_DIR/stage" summarize ffmpeg-wasm
: >"$TEST_DIR/release.keychain-db"
: >"$TEST_DIR/AuthKey_TEST.p8"

COMMON_ENV=(
  PATH="$MOCK_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  MOCK_LOG="$LOG"
  SUMMARIZE_OFFICIAL_RELEASE=1
  CODESIGN_IDENTITY="Developer ID Application: Peter Steinberger (Y5PE65HELJ)"
  CODESIGN_KEYCHAIN="$TEST_DIR/release.keychain-db"
  ASC_KEY_ID=ABCDEFGHIJ
  ASC_ISSUER_ID=11111111-2222-3333-4444-555555555555
  ASC_PRIVATE_KEY_PATH="$TEST_DIR/AuthKey_TEST.p8"
)

env "${COMMON_ENV[@]}" "$ROOT/scripts/codesign-macos.sh" "$TEST_DIR/stage/summarize" arm64
grep -F -- '--options runtime' "$LOG" >/dev/null || fail "codesign skipped hardened runtime"
grep -F -- '--identifier com.steipete.summarize.cli' "$LOG" >/dev/null || fail "codesign skipped stable identifier"
grep -F -- '--entitlements' "$LOG" >/dev/null || fail "codesign skipped Bun entitlements"
grep -F -- 'notarytool submit' "$LOG" >/dev/null || fail "notarytool was not invoked"
grep -F -- '--check-notarization -R=notarized' "$LOG" >/dev/null || fail "online notarization was not verified"

if env "${COMMON_ENV[@]}" CODESIGN_IDENTITY='Developer ID Application: Wrong (AAAAAAAAAA)' \
  "$ROOT/scripts/codesign-macos.sh" "$TEST_DIR/stage/summarize" arm64 >/dev/null 2>&1; then
  fail "wrong signing authority was accepted"
fi

if env "${COMMON_ENV[@]}" MOCK_NOTARY_STATUS=Invalid \
  "$ROOT/scripts/codesign-macos.sh" "$TEST_DIR/stage/summarize" arm64 >/dev/null 2>&1; then
  fail "rejected notarization was accepted"
fi

if env "${COMMON_ENV[@]}" MOCK_REQUIREMENT='identifier "com.wrong"' \
  "$ROOT/scripts/codesign-macos.sh" "$TEST_DIR/stage/summarize" arm64 >/dev/null 2>&1; then
  fail "wrong embedded requirement was accepted while signing"
fi

env \
  -u MACOS_SIGNING_P12 \
  -u MACOS_SIGNING_P12_PASSWORD \
  -u ASC_KEY_ID \
  -u ASC_ISSUER_ID \
  -u ASC_PRIVATE_KEY_P8 \
  -u CODESIGN_IDENTITY \
  -u CODESIGN_KEYCHAIN \
  -u ASC_PRIVATE_KEY_PATH \
  PATH="$MOCK_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  MOCK_LOG="$LOG" \
  "$ROOT/scripts/verify-macos-release.sh" "$TEST_DIR/release.tar.gz" arm64 0.21.6

if env \
  -u MACOS_SIGNING_P12 \
  -u MACOS_SIGNING_P12_PASSWORD \
  -u ASC_KEY_ID \
  -u ASC_ISSUER_ID \
  -u ASC_PRIVATE_KEY_P8 \
  -u CODESIGN_IDENTITY \
  -u CODESIGN_KEYCHAIN \
  -u ASC_PRIVATE_KEY_PATH \
  PATH="$MOCK_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  MOCK_LOG="$LOG" \
  MOCK_AUTHORITY='Developer ID Application: Wrong (AAAAAAAAAA)' \
  "$ROOT/scripts/verify-macos-release.sh" "$TEST_DIR/release.tar.gz" arm64 0.21.6 >/dev/null 2>&1; then
  fail "verifier accepted the wrong signing authority"
fi

if env \
  -u MACOS_SIGNING_P12 \
  -u MACOS_SIGNING_P12_PASSWORD \
  -u ASC_KEY_ID \
  -u ASC_ISSUER_ID \
  -u ASC_PRIVATE_KEY_P8 \
  -u CODESIGN_IDENTITY \
  -u CODESIGN_KEYCHAIN \
  -u ASC_PRIVATE_KEY_PATH \
  PATH="$MOCK_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  MOCK_LOG="$LOG" \
  MOCK_REQUIREMENT='identifier "com.wrong"' \
  "$ROOT/scripts/verify-macos-release.sh" "$TEST_DIR/release.tar.gz" arm64 0.21.6 >/dev/null 2>&1; then
  fail "verifier accepted the wrong embedded requirement"
fi

echo "macOS release contract tests passed"

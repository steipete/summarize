#!/usr/bin/env bash
# Local preview for the summarize docs (Jekyll).
# Usage:
#   scripts/docs-serve.sh                # serves on http://127.0.0.1:4000
#   scripts/docs-serve.sh --port 4001
#
# First run installs gems into docs/.bundle. After that, startup is instant.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_DIR="$REPO_ROOT/docs"

if ! command -v bundle >/dev/null 2>&1; then
  cat >&2 <<'EOF'
error: `bundle` not found.

Install Ruby + Bundler and try again. On macOS:
  brew install ruby
  echo 'export PATH="/opt/homebrew/opt/ruby/bin:$PATH"' >> ~/.zshrc
  gem install --user-install bundler

Or with rbenv / asdf - anything that ships a recent Ruby works.
EOF
  exit 1
fi

BUNDLE_BIN="${BUNDLE_BIN:-bundle}"
BUNDLE_ARGS=()
if [[ -n "${BUNDLE_VERSION:-}" ]]; then
  BUNDLE_ARGS=("_${BUNDLE_VERSION}_")
elif "$BUNDLE_BIN" _2.7.2_ --version >/dev/null 2>&1; then
  current_version="$("$BUNDLE_BIN" --version 2>/dev/null | awk '{print $NF}')"
  if [[ "$current_version" == 4.* ]]; then
    BUNDLE_ARGS=("_2.7.2_")
  fi
fi

bundle_cmd() {
  "$BUNDLE_BIN" "${BUNDLE_ARGS[@]}" "$@"
}

cd "$DOCS_DIR"

if [[ ! -d ".bundle" ]]; then
  echo "-> first run: installing gems into docs/.bundle ..." >&2
  bundle_cmd config set --local path '.bundle/vendor'
  bundle_cmd install
fi

exec "${BUNDLE_BIN}" "${BUNDLE_ARGS[@]}" exec jekyll serve \
  --livereload \
  --incremental \
  --port "${PORT:-4000}" \
  --host 127.0.0.1 \
  "$@"

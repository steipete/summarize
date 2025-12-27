#!/usr/bin/env bash
set -euo pipefail

# summarize release helper (npm)
# Phases: gates | build | publish | smoke | tag | all

# npm@11 warns on unknown env configs; keep CI/logs clean.
unset npm_config_manage_package_manager_versions || true

PHASE="${1:-all}"

banner() {
  printf "\n==> %s\n" "$1"
}

run() {
  echo "+ $*"
  "$@"
}

require_clean_git() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Git working tree is dirty. Commit or stash before releasing."
    exit 1
  fi
}

require_lockstep_versions() {
  local root_version core_version
  root_version="$(node -p 'require("./package.json").version')"
  core_version="$(node -p 'require("./packages/core/package.json").version')"
  if [ "$root_version" != "$core_version" ]; then
    echo "Version mismatch: root=$root_version core=$core_version"
    exit 1
  fi
}

phase_gates() {
  banner "Gates"
  require_clean_git
  require_lockstep_versions
  run pnpm check
}

phase_build() {
  banner "Build"
  require_lockstep_versions
  run pnpm build
}

phase_publish() {
  banner "Publish to npm"
  require_clean_git
  require_lockstep_versions
  run bash -c 'cd packages/core && pnpm publish --tag latest --access public'
  run pnpm publish --tag latest --access public
}

phase_smoke() {
  banner "Smoke"
  run npm view @steipete/summarize version
  run npm view @steipete/summarize-core version
  local version
  version="$(node -p 'require("./package.json").version')"
  run bash -c "pnpm -s dlx @steipete/summarize@${version} --help >/dev/null"
  echo "ok"
}

phase_tag() {
  banner "Tag"
  require_clean_git
  local version
  version="$(node -p 'require("./package.json").version')"
  run git tag -a "v${version}" -m "v${version}"
  run git push --tags
}

case "$PHASE" in
  gates) phase_gates ;;
  build) phase_build ;;
  publish) phase_publish ;;
  smoke) phase_smoke ;;
  tag) phase_tag ;;
  all)
    phase_gates
    phase_build
    phase_publish
    phase_smoke
    phase_tag
    ;;
  *)
    echo "Usage: scripts/release.sh [phase]"
    echo
    echo "Phases:"
    echo "  gates     pnpm check"
    echo "  build     pnpm build"
    echo "  publish   pnpm publish --tag latest --access public"
    echo "  smoke     npm view + pnpm dlx @steipete/summarize --help"
    echo "  tag       git tag vX.Y.Z + push tags"
    echo "  all       gates + build + publish + smoke + tag"
    exit 2
    ;;
esac

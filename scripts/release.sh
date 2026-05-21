#!/usr/bin/env bash
set -euo pipefail

# summarize release helper
# Phases: gates | build | bun | chrome | firefox | verify | publish | smoke | promote | tag | github | homebrew | deprecate | all

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

package_version() {
  node -p 'require("./package.json").version'
}

verify_package_manifest() {
  local tarball package_name version expected_core_dep
  tarball="$1"
  package_name="$2"
  version="$3"
  expected_core_dep="${4:-}"
  node - "${tarball}" "${package_name}" "${version}" "${expected_core_dep}" <<'NODE'
const { execFileSync } = require("node:child_process");
const [tarball, packageName, version, expectedCoreDep] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const raw = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
  encoding: "utf8",
});
const pkg = JSON.parse(raw);
if (pkg.name !== packageName) fail(`Expected ${packageName}, got ${pkg.name || "<missing>"}`);
if (pkg.version !== version) fail(`Expected ${packageName}@${version}, got ${pkg.version || "<missing>"}`);
const metadata = JSON.stringify({
  dependencies: pkg.dependencies || {},
  devDependencies: pkg.devDependencies || {},
  optionalDependencies: pkg.optionalDependencies || {},
  peerDependencies: pkg.peerDependencies || {},
});
if (metadata.includes("workspace:")) fail(`${packageName}@${version} tarball still contains workspace:* metadata`);
if (expectedCoreDep) {
  const actual = pkg.dependencies?.["@steipete/summarize-core"];
  if (actual !== expectedCoreDep) {
    fail(`Expected @steipete/summarize-core dependency ${expectedCoreDep}, got ${actual || "<missing>"}`);
  }
}
NODE
}

ensure_npm_version_absent() {
  local package_name version
  package_name="$1"
  version="$2"
  if npm view "${package_name}@${version}" version >/dev/null 2>&1; then
    echo "${package_name}@${version} already exists on npm; never republish an existing version."
    exit 1
  fi
}

require_npm_auth() {
  if npm whoami >/dev/null 2>&1; then
    return
  fi
  cat >&2 <<'EOF'
npm auth failed.
Run release publish from the tmux/1Password npm workflow with a temporary npmrc
(NPM_CONFIG_USERCONFIG) or a valid npm session. Do not use raw `npm publish`.
EOF
  exit 1
}

write_release_notes() {
  local version notes_file
  version="$1"
  notes_file="$2"
  awk -v start="$version" '
    BEGIN { p=0 }
    $0 ~ ("^## " start "([ -]|$)") { p=1; next }
    p && $0 ~ /^## / { exit }
    p { print }
  ' CHANGELOG.md >"${notes_file}"
  if ! grep -q '[^[:space:]]' "${notes_file}"; then
    echo "Missing CHANGELOG.md notes for ${version}"
    exit 1
  fi
}

phase_release_notes_preflight() {
  local version notes_file
  version="$(node -p 'require("./package.json").version')"
  notes_file="$(mktemp)"
  write_release_notes "${version}" "${notes_file}"
  rm -f "${notes_file}"
}

phase_gates() {
  banner "Gates"
  require_clean_git
  require_lockstep_versions
  phase_release_notes_preflight
  run pnpm check
}

phase_build() {
  banner "Build"
  require_lockstep_versions
  run pnpm build
  phase_bun
  phase_chrome
  phase_firefox
}

phase_bun() {
  banner "Bun artifacts"
  require_lockstep_versions
  run pnpm -C packages/core build
  run pnpm build:bun:test
}

phase_verify_pack() {
  banner "Verify pack"
  require_lockstep_versions
  local version tmp_dir tarball core_tarball install_dir
  version="$(node -p 'require("./package.json").version')"
  tmp_dir="$(mktemp -d)"
  core_tarball="${tmp_dir}/steipete-summarize-core-${version}.tgz"
  tarball="${tmp_dir}/steipete-summarize-${version}.tgz"
  run pnpm -C packages/core pack --pack-destination "${tmp_dir}"
  run pnpm pack --pack-destination "${tmp_dir}"
  if [ ! -f "${core_tarball}" ]; then
    echo "Missing ${core_tarball}"
    exit 1
  fi
  if [ ! -f "${tarball}" ]; then
    echo "Missing ${tarball}"
    exit 1
  fi
  verify_package_manifest "${core_tarball}" "@steipete/summarize-core" "${version}"
  verify_package_manifest "${tarball}" "@steipete/summarize" "${version}" "${version}"
  install_dir="${tmp_dir}/install"
  run mkdir -p "${install_dir}"
  run npm install --prefix "${install_dir}" "${core_tarball}" "${tarball}"
  run node "${install_dir}/node_modules/@steipete/summarize/dist/cli.js" --help >/dev/null
  echo "ok"
}

phase_chrome() {
  banner "Chrome extension"
  local version root_dir output_dir zip_path
  version="$(node -p 'require("./package.json").version')"
  root_dir="$(pwd)"
  output_dir="${root_dir}/apps/chrome-extension/.output"
  zip_path="${root_dir}/dist-chrome/summarize-chrome-extension-v${version}.zip"
  run pnpm -C apps/chrome-extension build
  run mkdir -p "${root_dir}/dist-chrome"
  if [ ! -d "${output_dir}/chrome-mv3" ]; then
    echo "Missing ${output_dir}/chrome-mv3 (wxt build failed?)"
    exit 1
  fi
  # Zip the *contents* of `chrome-mv3/` (no top-level folder) so users can unzip into any folder and load it via:
  # chrome://extensions → Developer mode → "Load unpacked" (manifest.json at the folder root).
  run bash -c "cd \"${output_dir}/chrome-mv3\" && zip -r -FS \"${zip_path}\" ."
  echo "Chrome extension: ${zip_path}"
}

phase_firefox() {
  banner "Firefox extension"
  local version root_dir output_dir zip_path
  version="$(node -p 'require("./package.json").version')"
  root_dir="$(pwd)"
  output_dir="${root_dir}/apps/chrome-extension/.output"
  zip_path="${root_dir}/dist-firefox/summarize-firefox-extension-v${version}.zip"
  run pnpm -C apps/chrome-extension build:firefox
  run mkdir -p "${root_dir}/dist-firefox"
  if [ ! -d "${output_dir}/firefox-mv3" ]; then
    echo "Missing ${output_dir}/firefox-mv3 (wxt build failed?)"
    exit 1
  fi
  # Zip the *contents* of `firefox-mv3/` (no top-level folder) so users can unzip into any folder and load it.
  # AMO requires manifest.json at the root of the zip.
  run bash -c "cd \"${output_dir}/firefox-mv3\" && zip -r -FS \"${zip_path}\" ."
  echo "Firefox extension: ${zip_path}"
}

phase_publish() {
  banner "Publish to npm"
  require_clean_git
  require_lockstep_versions
  require_npm_auth
  local version
  local -a otp_args=()
  version="$(package_version)"
  if [ -n "${NPM_OTP:-}" ]; then
    otp_args=(--otp "${NPM_OTP}")
  fi
  ensure_npm_version_absent "@steipete/summarize-core" "${version}"
  ensure_npm_version_absent "@steipete/summarize" "${version}"
  phase_verify_pack
  run bash -c 'cd packages/core && pnpm publish --tag next --access public "$@"' bash "${otp_args[@]}"
  run pnpm publish --tag next --access public "${otp_args[@]}"
  phase_smoke
  phase_promote_latest
}

phase_smoke() {
  banner "Smoke"
  require_lockstep_versions
  local version core_version core_dep cli_version dlx_version
  version="$(package_version)"
  core_version="$(npm view "@steipete/summarize-core@${version}" version)"
  cli_version="$(npm view "@steipete/summarize@${version}" version)"
  core_dep="$(npm view "@steipete/summarize@${version}" dependencies.@steipete/summarize-core)"
  if [ "${core_version}" != "${version}" ] || [ "${cli_version}" != "${version}" ]; then
    echo "npm exact-version lookup failed for ${version}: core=${core_version:-missing} cli=${cli_version:-missing}"
    exit 1
  fi
  if [ "${core_dep}" != "${version}" ]; then
    echo "Published CLI depends on @steipete/summarize-core=${core_dep:-missing}; expected ${version}"
    echo "Emergency path: do not tag/release. Deprecate this version and ship a patch."
    exit 1
  fi
  case "${core_dep}" in
    workspace:*)
      echo "Published CLI contains workspace dependency ${core_dep}; do not promote."
      echo "Emergency path: deprecate this version and ship a patch."
      exit 1
      ;;
  esac
  dlx_version="$(pnpm -s dlx "@steipete/summarize@${version}" --version)"
  if [ "${dlx_version}" != "${version}" ]; then
    echo "pnpm dlx reported ${dlx_version}, expected ${version}"
    exit 1
  fi
  run bash -c "pnpm -s dlx @steipete/summarize@${version} --help >/dev/null"
  echo "ok"
}

phase_promote_latest() {
  banner "Promote npm latest"
  require_npm_auth
  local version
  local -a otp_args=()
  version="$(package_version)"
  if [ -n "${NPM_OTP:-}" ]; then
    otp_args=(--otp "${NPM_OTP}")
  fi
  run npm dist-tag add "@steipete/summarize-core@${version}" latest "${otp_args[@]}"
  run npm dist-tag add "@steipete/summarize@${version}" latest "${otp_args[@]}"
  run npm view @steipete/summarize dist-tags.latest
  run npm view @steipete/summarize-core dist-tags.latest
}

phase_deprecate() {
  banner "Deprecate broken npm CLI version"
  require_npm_auth
  local bad_version message
  local -a otp_args=()
  bad_version="${BAD_VERSION:-}"
  if [ -z "${bad_version}" ]; then
    echo "Set BAD_VERSION=<version> to deprecate @steipete/summarize@<version>."
    exit 2
  fi
  message="${DEPRECATE_MESSAGE:-Broken package metadata. Use a newer version.}"
  if [ -n "${NPM_OTP:-}" ]; then
    otp_args=(--otp "${NPM_OTP}")
  fi
  run npm deprecate "@steipete/summarize@${bad_version}" "${message}" "${otp_args[@]}"
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

phase_github() {
  banner "GitHub release"
  require_clean_git
  require_lockstep_versions
  local version root_dir notes_file
  version="$(node -p 'require("./package.json").version')"
  root_dir="$(pwd)"
  local assets=(
    "${root_dir}/dist-bun/summarize-macos-arm64-v${version}.tar.gz"
    "${root_dir}/dist-bun/summarize-macos-x64-v${version}.tar.gz"
    "${root_dir}/dist-chrome/summarize-chrome-extension-v${version}.zip"
    "${root_dir}/dist-firefox/summarize-firefox-extension-v${version}.zip"
  )
  for asset in "${assets[@]}"; do
    if [ ! -f "${asset}" ]; then
      echo "Missing release asset: ${asset}"
      exit 1
    fi
  done
  if ! git rev-parse -q --verify "refs/tags/v${version}" >/dev/null; then
    echo "Missing tag v${version}. Run: scripts/release.sh tag"
    exit 1
  fi
  notes_file="$(mktemp)"
  write_release_notes "${version}" "${notes_file}"
  run gh release create "v${version}" "${assets[@]}" --verify-tag --title "v${version}" --notes-file "${notes_file}"
  run gh release view "v${version}" --json body --jq .body >/dev/null
}

phase_homebrew() {
  banner "Homebrew/core verify"
  require_lockstep_versions
  local version installed homebrew_bin homebrew_version
  version="$(node -p 'require("./package.json").version')"
  if ! command -v brew >/dev/null 2>&1; then
    echo "Homebrew not found"
    exit 1
  fi
  run brew update
  installed="$(brew info --json=v2 summarize | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{ const j=JSON.parse(s); const f=j.formulae?.[0]; console.log(f?.versions?.stable ?? ""); })')"
  if [ "${installed}" != "${version}" ]; then
    echo "Homebrew/core summarize is ${installed:-unknown}, expected ${version}. Wait for Homebrew autobump, then rerun."
    exit 1
  fi
  run brew reinstall summarize
  homebrew_bin="$(brew --prefix summarize)/bin/summarize"
  if [ ! -x "${homebrew_bin}" ]; then
    echo "Missing Homebrew summarize binary: ${homebrew_bin}"
    exit 1
  fi
  homebrew_version="$("${homebrew_bin}" --version)"
  case "${homebrew_version}" in
    "${version}"*) ;;
    *)
      echo "Homebrew summarize reports ${homebrew_version}, expected ${version}"
      exit 1
      ;;
  esac
  echo "${homebrew_version}"
}

case "$PHASE" in
  gates) phase_gates ;;
  build) phase_build ;;
  bun) phase_bun ;;
  verify) phase_verify_pack ;;
  publish) phase_publish ;;
  smoke) phase_smoke ;;
  promote) phase_promote_latest ;;
  deprecate) phase_deprecate ;;
  tag) phase_tag ;;
  github) phase_github ;;
  homebrew) phase_homebrew ;;
  chrome) phase_chrome ;;
  firefox) phase_firefox ;;
  all)
    phase_gates
    phase_build
    phase_publish
    phase_tag
    phase_github
    ;;
  *)
    echo "Usage: scripts/release.sh [phase]"
    echo
    echo "Phases:"
    echo "  gates     pnpm check"
    echo "  build     pnpm build + Bun/Chrome/Firefox artifacts"
    echo "  bun       build + smoke Bun release tarballs"
    echo "  verify    pack + install tarball + --help"
    echo "  publish   pnpm publish --tag next, smoke exact version, then promote latest"
    echo "  smoke     npm exact-version metadata + pnpm dlx --version/--help"
    echo "  promote   npm dist-tag add current version as latest"
    echo "  deprecate deprecate @steipete/summarize@BAD_VERSION"
    echo "  tag       git tag vX.Y.Z + push tags"
    echo "  github    create GitHub Release + upload release assets"
    echo "  homebrew  verify Homebrew/core formula has current version"
    echo "  chrome    build + zip Chrome extension"
    echo "  firefox   build + zip Firefox extension"
    echo "  all       gates + build + verify + publish + tag + github"
    exit 2
    ;;
esac

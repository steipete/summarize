#!/usr/bin/env bash
set -euo pipefail

# summarize release helper (npm)
# Phases: gates | build | publish | smoke | tag | tap | chrome | firefox | all

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
  phase_chrome
  phase_firefox
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

# sha256_file <path> — cross-platform SHA-256 (macOS uses shasum, Linux uses sha256sum)
sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

phase_tap() {
  banner "Homebrew tap"
  local version root_dir tap_dir formula_path tmp_dir
  local repo gh_repo
  local url_macos_arm64 sha_macos_arm64
  local url_linux_x64 sha_linux_x64
  local url_linux_arm64 sha_linux_arm64

  version="$(node -p 'require("./package.json").version')"
  root_dir="$(pwd)"
  tap_dir="${root_dir}/../homebrew-tap"
  formula_path="${tap_dir}/Formula/summarize.rb"

  # Derive the GitHub repo from the git remote so forks work automatically.
  gh_repo="$(git remote get-url origin | sed -E 's|.*github\.com[:/]||; s|\.git$||')"

  if [ ! -d "${tap_dir}/.git" ]; then
    echo "Missing tap repo at ${tap_dir}"
    exit 1
  fi
  if ! git -C "${tap_dir}" diff --quiet || ! git -C "${tap_dir}" diff --cached --quiet; then
    echo "Tap repo is dirty: ${tap_dir}"
    exit 1
  fi

  tmp_dir="$(mktemp -d)"
  base_url="https://github.com/${gh_repo}/releases/download/v${version}"

  # Download each platform tarball and compute its SHA-256.
  for platform in macos-arm64 linux-x64 linux-arm64; do
    tarball_name="summarize-${platform}-v${version}.tar.gz"
    tarball_path="${tmp_dir}/${tarball_name}"
    url="${base_url}/${tarball_name}"
    echo "Fetching ${url}…"
    if run curl -fsSL "${url}" -o "${tarball_path}"; then
      sha="$(sha256_file "${tarball_path}")"
    else
      echo "Warning: ${platform} tarball not found at ${url}, skipping."
      sha=""
    fi
    case "$platform" in
      macos-arm64) url_macos_arm64="$url"; sha_macos_arm64="$sha" ;;
      linux-x64)   url_linux_x64="$url";   sha_linux_x64="$sha"   ;;
      linux-arm64) url_linux_arm64="$url"; sha_linux_arm64="$sha" ;;
    esac
  done

  # Rewrite the formula with updated URLs and checksums for all platforms.
  run python3 - \
    "${formula_path}" \
    "${url_macos_arm64}"  "${sha_macos_arm64}" \
    "${url_linux_x64}"    "${sha_linux_x64}" \
    "${url_linux_arm64}"  "${sha_linux_arm64}" \
    <<'PY'
import sys
from pathlib import Path

(path,
 url_macos_arm64,  sha_macos_arm64,
 url_linux_x64,    sha_linux_x64,
 url_linux_arm64,  sha_linux_arm64) = sys.argv[1:]

def platform_block(outer, inner, url, sha):
    """Return an on_<outer> { on_<inner> } block, or '' if sha is missing."""
    if not sha:
        return ""
    return f"""
  on_{outer} do
    on_{inner} do
      url "{url}"
      sha256 "{sha}"
    end
  end
"""

macos_block  = platform_block("macos", "arm",   url_macos_arm64,  sha_macos_arm64)
linux_x64    = platform_block("linux", "intel", url_linux_x64,    sha_linux_x64)
linux_arm64  = platform_block("linux", "arm",   url_linux_arm64,  sha_linux_arm64)

# Merge both linux blocks under a single on_linux do...end wrapper.
if linux_x64 or linux_arm64:
    intel_inner = f"    on_intel do\n      url \"{url_linux_x64}\"\n      sha256 \"{sha_linux_x64}\"\n    end\n" if sha_linux_x64 else ""
    arm_inner   = f"    on_arm do\n      url \"{url_linux_arm64}\"\n      sha256 \"{sha_linux_arm64}\"\n    end\n" if sha_linux_arm64 else ""
    linux_block = f"\n  on_linux do\n{intel_inner}{arm_inner}  end\n"
else:
    linux_block = ""

formula = f"""class Summarize < Formula
  desc "Link → clean text → summary"
  homepage "https://github.com/steipete/summarize"
  license "MIT"
{macos_block}{linux_block}
  def install
    bin.install "summarize"
  end

  def post_install
    chmod 0755, "#{{bin}}/summarize"
  end

  test do
    assert_match version.to_s, shell_output("#{{bin}}/summarize --version")
    assert_match "Summarize web pages", shell_output("#{{bin}}/summarize --help")
  end
end
"""
Path(path).write_text(formula)
PY

  echo "Tap updated: ${formula_path}"
  echo "Next: git -C ${tap_dir} add ${formula_path} && git -C ${tap_dir} commit -m \"chore: bump summarize to v${version}\" && git -C ${tap_dir} push"
}

case "$PHASE" in
  gates) phase_gates ;;
  build) phase_build ;;
  verify) phase_verify_pack ;;
  publish) phase_publish ;;
  smoke) phase_smoke ;;
  tag) phase_tag ;;
  tap) phase_tap ;;
  chrome) phase_chrome ;;
  firefox) phase_firefox ;;
  all)
    phase_gates
    phase_build
    phase_verify_pack
    phase_publish
    phase_smoke
    phase_tag
    phase_tap
    ;;
  *)
    echo "Usage: scripts/release.sh [phase]"
    echo
    echo "Phases:"
    echo "  gates     pnpm check"
    echo "  build     pnpm build"
    echo "  verify    pack + install tarball + --help"
    echo "  publish   pnpm publish --tag latest --access public"
    echo "  smoke     npm view + pnpm dlx @steipete/summarize --help"
    echo "  tag       git tag vX.Y.Z + push tags"
    echo "  tap       update homebrew-tap formula + sha"
    echo "  chrome    build + zip Chrome extension"
    echo "  firefox   build + zip Firefox extension"
    echo "  all       gates + build + verify + publish + smoke + tag + tap"
    exit 2
    ;;
esac

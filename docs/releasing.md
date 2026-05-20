---
title: "Releasing"
kicker: "project"
summary: "Release checklist + Homebrew/core verify step."
---

# Releasing

## Goals

- Ship npm packages (core first, then CLI).
- Tag + GitHub release.
- Verify the Homebrew/core formula so `brew install summarize` matches the latest tag.

## Checklist

1. `scripts/release.sh all` (gates → build all assets → pack verify → publish → smoke → tag → GitHub release/assets).
2. Verify the GitHub release notes and uploaded Bun/extension assets.
3. After Homebrew/core autobump catches up, verify the formula reflects the new version:
   - `scripts/release.sh homebrew`
   - `brew install summarize`
   - `summarize --version` matches tag.
   - Run a feature added in the release (for example `summarize daemon install`).
4. If anything fails, fix and re-cut the release (no partials).

## Common failure

- NPM/GitHub release updated, but Homebrew/core still serves the old version.
  Fix: always do step 3 before announcing.

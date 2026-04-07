---
summary: "Release checklist + Homebrew/core verify step."
---

# Releasing

## Goals

- Ship npm packages (core first, then CLI).
- Tag + GitHub release.
- Verify the Homebrew/core formula so `brew install summarize` matches the latest tag.

## Checklist

1. `scripts/release.sh all` (gates → build → verify → publish → smoke → tag).
2. Create GitHub release for the new tag (match version, attach notes/assets as needed).
3. Verify the Homebrew/core formula reflects the new version:
   - `brew install summarize`
   - `summarize --version` matches tag.
   - Run a feature added in the release (for example `summarize daemon install`).
4. If anything fails, fix and re-cut the release (no partials).

## Common failure

- NPM/GitHub release updated, but Homebrew/core still serves the old version.
  Fix: always do step 3 before announcing.

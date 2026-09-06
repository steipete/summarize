---
title: "Releasing"
kicker: "project"
summary: "Release checklist, Chrome Web Store submission, and Homebrew/core verification."
---

# Releasing

## Goals

- Ship npm packages (core first, then CLI).
- Tag + GitHub release.
- Submit the matching extension package to the Chrome Web Store unless the release is daemon-only.
- Leave formula updates to Homebrew/core autobump; optionally verify after it catches up.

## Checklist

1. `scripts/release.sh all` (gates → build all assets → pack verify → publish → smoke → tag → GitHub release/assets).
2. Verify the GitHub release notes and uploaded Bun/extension assets.
3. Submit the Chrome extension update:
   - Skip this step only when every shipped change is daemon-side and the packaged extension and its companion contract are unchanged.
   - Using the existing authenticated Chrome profile, open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/) and select item `cejgnmmhbbpdmjnfppjdfkocebngehfg`.
   - Upload `dist-chrome/summarize-chrome-extension-v<version>.zip`.
   - Add source-backed Privacy-tab justifications for any newly declared permissions, then save the draft.
   - Submit for review with automatic publishing enabled. Verify the dashboard shows the exact draft version as `Pending review` or `Published`; the public listing can remain on the prior version until review completes.
4. Optional follow-up, not a release gate: after Homebrew/core autobump catches up, verify the formula reflects the new version:
   - `scripts/release.sh homebrew`
   - `brew install summarize`
   - `summarize --version` matches tag.
   - Run a feature added in the release (for example `summarize daemon install`).
5. If a required release step fails, fix it before closeout. Homebrew/core autobump lag does not require re-cutting or delaying a completed release.

## Common failure

- NPM/GitHub release updated, but Homebrew/core still serves the old version.
  Expected while autobump is pending. Do not manually update the formula or block the release; step 4 can verify it later.
- GitHub Release contains the extension ZIP, but the Chrome Web Store still serves an old version.
  Fix: submit the matching ZIP in step 3 and verify the draft/review state before closeout.

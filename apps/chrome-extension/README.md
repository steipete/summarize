# Summarize (Chrome Extension)

Chrome Side Panel UI for `summarize` (streams summaries into a real Chrome Side Panel).

Docs + setup: `https://summarize.sh`

## Build

- From repo root: `pnpm install`
- Dev: `pnpm -C apps/chrome-extension dev`
- Prod build: `pnpm -C apps/chrome-extension build`

## Load Unpacked

- Chrome → `chrome://extensions` → Developer mode → “Load unpacked”
- Pick: `apps/chrome-extension/.output/chrome-mv3`

## Length Presets

- Presets match CLI: `short|medium|long|xl|xxl` (or custom like `20k`).
- Tooltips show target + range + paragraph guidance.
- Source of truth: `packages/core/src/prompts/summary-lengths.ts`.

## First Run (Pairing)

- Install summarize (choose one):
  - `npm i -g @steipete/summarize`
  - `brew install steipete/tap/summarize` (macOS arm64)
- Open side panel → “Setup” shows a token + install command.
- Run the command in Terminal (macOS: LaunchAgent, Linux: systemd user, Windows: Scheduled Task).

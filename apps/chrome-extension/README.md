# Summarize (Browser Extension)

Browser extension for Chrome and Firefox that streams AI-powered summaries directly into your browser's sidebar/side panel.

**Supported browsers**:
- Chrome (Side Panel)
- Firefox 131+ (Sidebar)

Docs + setup: `https://summarize.sh`

## Build

- From repo root: `pnpm install`
- Chrome dev: `pnpm -C apps/chrome-extension dev`
- Firefox dev: `pnpm -C apps/chrome-extension dev:firefox`
- Prod build (Chrome): `pnpm -C apps/chrome-extension build`
- Prod build (Firefox): `pnpm -C apps/chrome-extension build:firefox`
- Build both: `pnpm -C apps/chrome-extension build:all`

## Install in Chrome (Unpacked)

Step-by-step:

1) Build the extension:
   - `pnpm -C apps/chrome-extension build`
2) Open Chrome → go to `chrome://extensions`
   - Or Chrome menu → Extensions → “Manage Extensions”
3) Turn on **Developer mode** (top-right toggle).
4) Click **Load unpacked**.
5) Select the folder: `apps/chrome-extension/.output/chrome-mv3`
6) You should now see “Summarize” in the extensions list.
7) (Optional) Pin the extension (puzzle icon → pin), then click it to open the Side Panel.

Developer mode is required for loading unpacked extensions.

## Install in Firefox (Temporary Add-on)

Step-by-step:

1) Build the Firefox extension:
   - `pnpm -C apps/chrome-extension build:firefox`
2) Open Firefox → go to `about:debugging#/runtime/this-firefox`
   - Or Firefox menu → More tools → "This Firefox" (under "Debugging")
3) Click **Load Temporary Add-on**
4) Navigate to and select: `apps/chrome-extension/.output/firefox-mv3/manifest.json`
5) You should now see "Summarize" in the extensions list
6) Open the sidebar: View menu → Sidebar → Summarize (or Ctrl/Cmd+B)

**Note**: Temporary add-ons are removed when Firefox restarts. For permanent installation, the extension needs to be signed via AMO (Firefox Add-ons).

## Install the Daemon (Pairing)

The extension talks to a tiny local daemon that runs on your machine. This process is identical for both Chrome and Firefox.

1) Install `summarize` (choose one):
   - `npm i -g @steipete/summarize` (requires Node.js 22+)
   - `brew install steipete/tap/summarize` (macOS arm64)
2) Open the Side Panel (Chrome) or Sidebar (Firefox). You'll see a **Setup** screen with a token and an install command.
3) Open Terminal:
   - macOS: Applications → Utilities → Terminal
   - Windows: Start menu → Terminal (or PowerShell)
   - Linux: your Terminal app
4) Paste the command from the Setup screen and press Enter.
   - Installed binary: `summarize daemon install --token <TOKEN>`
   - Repo/dev checkout: `pnpm summarize daemon install --token <TOKEN> --dev`
5) Back in your browser, the Setup screen should disappear once the daemon is running.
6) Verify / troubleshoot:
   - `summarize daemon status`
   - `summarize daemon restart`

## Length Presets

- Presets match CLI: `short|medium|long|xl|xxl` (or custom like `20k`).
- Tooltips show target + range + paragraph guidance.
- Source of truth: `packages/core/src/prompts/summary-lengths.ts`.

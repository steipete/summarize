# Summarize (Browser Extension)

Browser extension for Chrome and Firefox that streams AI-powered summaries directly into your browser's sidebar/side panel.

**Supported browsers**:

- Chrome 120+ (Side Panel) - Auto-opens on toolbar icon click
- Firefox 140+ (Sidebar) - Toggle with toolbar icon or `Ctrl+Shift+U`

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

1. Build the extension:
   - `pnpm -C apps/chrome-extension build`
2. Open Chrome → go to `chrome://extensions`
   - Or Chrome menu → Extensions → “Manage Extensions”
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the folder: `apps/chrome-extension/.output/chrome-mv3`
6. You should now see “Summarize” in the extensions list.
7. (Optional) Pin the extension (puzzle icon → pin), then click it to open the Side Panel.

Developer mode is required for loading unpacked extensions.

## Install in Firefox (Temporary Add-on)

Step-by-step:

1. Build the Firefox extension:
   - `pnpm -C apps/chrome-extension build:firefox`
2. Open Firefox → go to `about:debugging#/runtime/this-firefox`
   - Or Firefox menu → More tools → "This Firefox" (under "Debugging")
3. Click **Load Temporary Add-on**
4. Navigate to and select: `apps/chrome-extension/.output/firefox-mv3/manifest.json`
5. You should now see "Summarize" in the extensions list
6. Open the sidebar using any of these methods:
   - **Click the Summarize toolbar icon** (toggles sidebar open/close)
   - **Keyboard shortcut**: `Ctrl+Shift+U` (Windows/Linux) or `Cmd+Shift+U` (Mac)
   - **Menu**: View → Sidebar → Summarize

**Customize keyboard shortcut** (optional):

- Go to `about:addons` → Extensions → ⚙️ (gear icon) → Manage Extension Shortcuts
- Find "Summarize" and click the current shortcut to change it

**Note**: Temporary add-ons are removed when Firefox restarts. For permanent installation, the extension needs to be signed via AMO (Firefox Add-ons).

## AI and Media Runtimes

The extension separates its AI connection from media/slide extraction:

- **Direct**: Auto calls a configured OpenAI, OpenRouter, Anthropic, Gemini, xAI, Z.AI, NVIDIA, MiniMax, GitHub Models, Ollama, or overridden compatible endpoint directly from Chrome. Without a configured provider, Auto uses Chrome's built-in Gemini Nano Summarizer API with extractive fallback. Gemini Nano can also be selected explicitly. Provider-backed chat, automation, and hover summaries work without the daemon. Keys stay in `chrome.storage.local` and are sent only to the selected provider.
- **Daemon**: uses the local Summarize daemon and its configured providers, CLI fallbacks, cache, and diagnostics. Explicitly selecting Gemini Nano still keeps summaries on-device while daemon-only capabilities remain available.

Media/slides can independently use **Browser** or **Daemon**. Browser media uses MediaBunny with native WebCodecs for fetchable video slides up to 128 MB and transcribes captionless YouTube videos with local multilingual Whisper. The Whisper model downloads on first use and is cached by Chrome. Daemon media adds native tools, configurable transcription providers, OCR, broader media support, and Firefox media support.

## Optional Daemon (Pairing)

1. Install `summarize` (choose one):
   - `npm i -g @steipete/summarize` (requires Node.js 24+)
   - `brew install summarize` (macOS, Linux)
2. Switch the AI connection or media runtime to **Daemon**, then copy the pairing token and install command from the extension.
3. Open Terminal:
   - macOS: Applications → Utilities → Terminal
   - Windows: Start menu → Terminal (or PowerShell) — **right-click → Run as administrator**
   - Linux: your Terminal app
4. Paste the command from the Setup screen and press Enter.
   - Installed binary: `summarize daemon install --token <TOKEN>`
   - Repo/dev checkout: `pnpm summarize daemon install --token <TOKEN> --dev`
5. Back in your browser, the Daemon runtime setup screen should disappear once the daemon is running.
6. Verify / troubleshoot:
   - `summarize daemon status`
   - `summarize daemon restart`

## Length Presets

- Presets match CLI: `short|medium|long|xl|xxl` (or custom like `20k`).
- Tooltips show target + range + paragraph guidance.
- Source of truth: `packages/core/src/prompts/summary-lengths.ts`.

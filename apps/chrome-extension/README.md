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
- Debugger-enabled automation build (Chrome): `pnpm -C apps/chrome-extension build:automation`
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

- **Direct**: works immediately with Auto using Chrome's built-in Gemini Nano Summarizer API and extractive fallback. A dismissible hint offers the optional daemon for faster media, OCR, and broader capabilities. Auto calls a configured OpenAI, OpenRouter, Anthropic, Gemini, xAI, Z.AI, NVIDIA, MiniMax, GitHub Models, Ollama, or overridden compatible endpoint directly from Chrome. Gemini Nano can also be selected explicitly. Provider-backed chat, automation, and hover summaries work without the daemon. Keys stay in `chrome.storage.local` and are sent only to the selected provider.
- **Daemon**: uses the local Summarize daemon and its configured providers, CLI fallbacks, cache, and diagnostics. Explicitly selecting Gemini Nano still keeps summaries on-device while daemon-only capabilities remain available.

Media/slides can independently use **Browser** or **Daemon**. Browser media uses MediaBunny with native WebCodecs for fetchable video slides up to 128 MB, summarizes each slide with Gemini Nano, and transcribes captionless YouTube videos with local multilingual Whisper. The AI models download on first use and are cached by Chrome. Daemon media adds native tools, configurable transcription providers, OCR, broader media support, and Firefox media support.

## Optional Daemon (Pairing)

1. Install `summarize` (choose one):
   - `npm i -g @steipete/summarize` (requires Node.js 24+)
   - `brew install summarize` (macOS, Linux)
2. Under **Options → Runtime → Daemon**, click **Enable local companion** and approve Chrome's
   optional **Communicate with cooperating native applications** permission. Switching either
   runtime to **Daemon** also starts this explicit permission flow. The side panel's **Connect**
   daemon hint opens this Runtime setup view directly.
3. Switch the AI connection or media runtime to **Daemon**, then copy the pairing token and install command from the extension.
4. Open Terminal:
   - macOS: Applications → Utilities → Terminal
   - Windows: Start menu → Terminal (or PowerShell) — **right-click → Run as administrator**
   - Linux: your Terminal app
5. Paste the command from the Setup screen and press Enter.
   - Installed binary: `summarize daemon install --token <TOKEN> --port 8787`
   - Repo/dev checkout: `pnpm summarize daemon install --token <TOKEN> --port 8787 --dev --extension-id <UNPACKED_ID>`
   - The install registers native host `com.steipete.summarize` for the exact Web Store extension ID.
   - Non-default port: replace `8787`, then enter the same port under **Options → Runtime → Daemon → Port**.
6. Back in your browser, the Daemon runtime setup screen should disappear once the daemon is running.
7. Verify / troubleshoot:
   - `summarize daemon status`
   - `summarize daemon restart`

Chrome communicates with the daemon only through the optional native host. The manifest retains
loopback access for configured Direct local providers, but those requests never enter the daemon
bridge. The npm-installed Windows CLI still needs a packaged native-host `.exe` before Daemon mode
can work there. Direct and Browser modes are unaffected.

Company administrators can keep Direct and Browser modes available while blocking all daemon
access with Chrome policy; see [`docs/chrome-enterprise.md`](../../docs/chrome-enterprise.md).

## Optional Website Automation

Summarization, chat, and browser media do not require Chrome's `userScripts` or `debugger`
permissions. Website automation is off by default. **Options → Enable automation permissions**
requests optional `userScripts` access from an explicit user click so user-requested `browserjs()` /
REPL code can run in the page's main world.

Chrome does not allow `debugger` to be declared optional. The standard Chrome build omits it and
hides the debugger tool; `pnpm -C apps/chrome-extension build:automation` creates the separate
debugger-enabled build for native click/type/key input and the explicit debugger tool. That build
declares `debugger` as required, attaches only while executing a debugger-backed command, and then
detaches.

## Length Presets

- Presets match CLI: `short|medium|long|xl|xxl` (or custom like `20k`).
- Tooltips show target + range + paragraph guidance.
- Source of truth: `packages/core/src/prompts/summary-lengths.ts`.

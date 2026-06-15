---
title: "Chrome extension"
kicker: "apps"
summary: "Chrome side panel extension + daemon architecture, setup, and troubleshooting."
read_when:
  - "When working on the extension, daemon, or side panel UX."
---

# Browser Side Panel (Chrome + Firefox Extension + Daemon)

Goal: Chrome **Side Panel** (“real sidebar”) summarizes **what you see** on the current tab. Panel open → navigation → auto summarize (optional) → **streaming** Markdown rendered in-panel.

Quickstart:

- Build/load extension: `apps/chrome-extension/README.md`
- Direct mode works immediately without a daemon. Auto uses a configured provider, otherwise Gemini Nano when available with extractive fallback.
- Configured direct providers support summaries, chat, automation, hover summaries, and public-URL extraction without a daemon. Provider keys stay in extension-local storage.
- Browser media provides daemonless transcription and slides. OCR, process/log tools, CLI fallbacks, and broader native media support require the daemon.
- Optional: install summarize for daemon-backed media support:
  - `npm i -g @steipete/summarize`
  - `brew install summarize` (macOS, Linux)
- Firefox sidebar build: `pnpm -C apps/chrome-extension build:firefox` (load via `about:debugging` → temporary add-on)
- Open side panel → copy token install command → run for daemon mode:
  - `summarize daemon install --token <TOKEN>` (macOS: LaunchAgent, Linux: systemd user, Windows: Scheduled Task)
- Verify:
  - `summarize daemon status`
  - Restart (if needed): `summarize daemon restart`

Firefox notes:

- Sidebar UX differs from Chrome’s side panel (persistent sidebar instead of slide-in panel).
- Firefox loading is smoke-tested with Mozilla `web-ext`; Playwright page-level Firefox tests remain diagnostic-only. See `apps/chrome-extension/tests/README-firefox.md`.
- Compatibility details: `apps/chrome-extension/docs/firefox.md`.

Dev (repo checkout):

- Use: `pnpm summarize daemon install --token <TOKEN> --dev` (autostart service runs `src/cli.ts` via Node's native TypeScript support; no `dist/` build required).
- E2E (Playwright): `pnpm -C apps/chrome-extension test:e2e`
  - First run: `pnpm -C apps/chrome-extension exec playwright install chromium`
  - Chromium runs headless by default.
  - Visible debugging: `SHOW_UI=1 pnpm -C apps/chrome-extension test:e2e` or `HEADLESS=0 pnpm -C apps/chrome-extension test:e2e`

## Troubleshooting

- “Daemon not reachable”:
  - `summarize daemon status`
  - Logs: `~/.summarize/logs/daemon.err.log`
- Windows install:
  - `summarize daemon install` registers a Scheduled Task via `schtasks /Create /XML`, which requires an **elevated** shell. Run it from an Administrator PowerShell/cmd; otherwise you'll see `schtasks create failed: ERROR: Access is denied.`
  - The task launches `wscript.exe //B //Nologo %USERPROFILE%\.summarize\daemon-launch.vbs`. If install completes but `/health` is unreachable, run `cscript //nologo %USERPROFILE%\.summarize\daemon-launch.vbs` to surface launcher errors, then `schtasks /Query /TN "Summarize Daemon" /V /FO LIST` to inspect the task state.
- macOS `launchctl bootstrap` errors (`Input/output error`, `Domain does not support specified action`):
  - `summarize daemon install` now tries both launchd domains (`gui/<uid>` then `user/<uid>`).
  - Install as your normal user (not root) so HOME + launchd domain match.
  - Re-run: `summarize daemon install --token <TOKEN>`.
- Windows containers:
  - `summarize daemon install --token <TOKEN>` starts the daemon for the current container session but does not create a Scheduled Task.
  - Run that command manually each time the container starts, or add it to your container startup. Also publish the daemon port in `docker-compose.yml`:
    `ports: ['8787:8787']`
    `command: ['cmd', '/c', 'summarize daemon install --token <TOKEN>']`
  - Then restart the container and verify `http://127.0.0.1:8787/health`.
- “Need extension-side traces”:
  - Options → Logs → `extension.log` (panel/background events).
  - Enable “Extended logging” in Advanced settings for full pipeline traces.
- Captionless YouTube transcription is slow on first use:
  - Chrome downloads and caches the multilingual Whisper Tiny model on demand.
  - WebGPU is preferred; a slower WASM/CPU path is used when WebGPU is unavailable.
  - Offline model bundling and subscription/download workflows are not currently provided.
- “Stream ended unexpectedly” / empty chat response:
  - The daemon likely stopped mid-stream. Restart it, then click “Try again”.
  - `summarize daemon restart`
- Slide strip/gallery missing after a parallel slide run failure:
  - Click the slide notice “Try again” button. If the dedicated slide run never started, the extension now requests a fresh summarize+slides run instead of reusing the summary-only run.
- Tweet video not transcribing / no progress:
  - Ensure `yt-dlp` is available on your PATH (or set `YT_DLP_PATH`) and you have a transcription provider (`whisper.cpp` installed or `GROQ_API_KEY` / `ASSEMBLYAI_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` / `FAL_KEY`).
  - Re-run `summarize daemon install --token <TOKEN>` to refresh the daemon env snapshot (launchd won’t inherit your shell PATH).
- “Could not establish connection / Receiving end does not exist”:
  - The content script wasn’t injected (yet), or Chrome blocked site access.
  - Chrome → extension details → “Site access” → “On all sites” (or allow the domain), then reload the tab.
- “<site> wants to look for and connect to any device on your local network”:
  - Trigger: content scripts (page context) hitting the daemon on `http://127.0.0.1:8787` (hover summaries) can cause Chrome to attribute the request to the current origin and prompt per-site.
  - Fix: hover summaries must proxy daemon calls via the extension background service worker (reload the extension after updating).
  - Verify daemon: `summarize daemon status` (or `curl http://127.0.0.1:8787/health`).
  - Repro/dev: `pnpm -C apps/chrome-extension dev` then enable “Hover summaries” and hover a link.

## Architecture

- **Extension (MV3, WXT)**
  - Side Panel UI: length + typography controls (font family + size), auto/manual toggle.
  - Background service worker: tab + navigation tracking, content extraction, starts summarize runs.
  - Chrome offscreen page: runs MediaBunny with native WebCodecs for ranged video slides and chunked local media transcription, plus an idle-evictable Whisper runtime.
  - Content script: extract readable article text from the **rendered DOM** via Readability; also detect SPA URL changes.
  - Direct provider adapters: OpenAI-compatible SSE, Anthropic Messages SSE, and Gemini SSE, normalized to the same summary/chat/tool-call contracts.
  - Panel page streams SSE directly (MV3 service workers can be flaky for long-lived streams).
- **Daemon (local, autostart service)**
  - HTTP server on `127.0.0.1:8787` only.
  - Token-authenticated API.
  - Runs the existing summarize pipeline (env/config-based) and streams tokens to client via SSE.

## Data Flow

1. User opens side panel (click extension icon).
2. Panel sends a “ready” message to the background (plus periodic “ping” heartbeats while open).
3. On nav/tab change (and auto enabled): background asks the content script to extract `{ url, title, text }` (best-effort).
4. In Chrome Browser mode, fetchable audio is decoded in bounded chunks through MediaBunny/WebCodecs and transcribed locally. YouTube prefers active-player/watch-page direct audio, then Android VR, buffered direct audio, and captured SABR.
5. In Direct mode, background uses Gemini Nano for Auto without provider credentials, or calls the selected provider and returns the normalized summary/chat result to the panel.
6. In Daemon mode, background `POST`s payload to `/v1/summarize` with `Authorization: Bearer <token>`; the panel streams `/v1/summarize/<id>/events`.

## Auto Mode (URL + Page Text)

The extension always sends the same request shape:

- Always: `url`, `title`
- When available: extracted `text` + `truncated`
- `mode: "auto"`

The daemon decides the best pipeline:

- YouTube / video / podcast / direct media URLs → prefer **URL** pipeline (transcripts, yt-dlp, Whisper, readability, …).
- Normal articles with extracted text → prefer **page** pipeline (“what you see”).
- Fallback: if the preferred path fails before output starts, try the other input (when available).

## Video Selection (Page vs Video)

When the page contains embedded audio/video, the Summarize button gains a dropdown caret. Click the caret to pick Page vs Video/Audio. Selecting Video/Audio forces URL mode with transcript-first extraction (captions → yt-dlp/Whisper fallback). Selection is per-run (not persisted).

See `docs/media.md` for detection and transcript rules.

## Slides (Side Panel)

- The slides toggle lights up on media-friendly URLs (YouTube/watch|shorts, youtu.be, direct media) or when the page reports video/audio. Defaults to Video on those pages.
- Turning slides **on** refreshes the current summary and requests slide extraction. Chrome Browser mode uses MediaBunny with native WebCodecs and ranged reads for fetchable videos, then falls back to visible-tab capture. Daemon mode adds `yt-dlp`, native ffmpeg, and optional `tesseract` OCR.
- Active slide mode is slide-first:
  - vertical image/text cards
  - transcript-first text; OCR fallback
  - text can appear before slide images finish extracting
  - the large summary block is hidden while slide cards are active
- Slides stay off elsewhere and the toggle is disabled on non-media pages.

## SPA Navigation

- Background listens to `chrome.webNavigation.onHistoryStateUpdated` (SPA route changes) and `tabs.onUpdated` (page loads).
- Only triggers summarize when the side panel is open (and auto is enabled).

## Markdown Rendering

- Use `markdown-it` in the panel.
- Disable raw HTML: `html: false` (avoid sanitizing libraries).
- `linkify: true`.
- Render links with `target=_blank` + `rel=noopener noreferrer`.

## Timestamp Links (Chat)

- When timed transcripts are available, chat context includes `[mm:ss]` lines.
- Assistant is prompted to cite timestamps; clicking them seeks the current media (video/audio) while preserving play/pause state.

## Model Selection UX

- Settings:
  - AI connection (Options → Runtime): Direct | Daemon.
  - Direct provider and credential/base URL (Options → Runtime). `auto` uses the configured provider, otherwise Gemini Nano; an explicit provider prefix overrides the selection.
  - Media/slide runtime (Options → Runtime): Browser | Daemon.
  - Model preset: `auto` | Gemini Nano | `free` | custom string (e.g. `openai/gpt-5-mini`, `openrouter/...`, `github-copilot/...`). Explicit Gemini Nano summaries stay on-device in either connection mode.
  - Length: `short|medium|long|xl|xxl` (or a character target like `20k`). Tooltips show target ranges + paragraph guidance (from `packages/core/src/prompts/summary-lengths.ts`).
  - Language: `auto` (match source) or a tag like `en`, `de`, `pt-BR` (or free-form like “German”).
  - Prompt override (advanced): custom instruction prefix (context + content still appended).
  - Auto summarize: on/off.
  - Hover summaries: on/off (side panel drawer, default off).
  - Typography: font family (dropdown + custom), font size (slider).
- Advanced overrides (Options → Advanced tab).
  - Leave blank to use daemon config/defaults; set a value to override.
  - Chat: enabled for a configured Direct provider or authenticated daemon.
  - Summary timestamps (advanced): include `[mm:ss]` links in summaries for media when available (default on).
  - Slides parallel (advanced): show summary first and extract slides in parallel (default on).
  - Slides OCR text (advanced): allow OCR text as a slide text source (default off).
  - Extended logging: send full input/output to daemon logs (requires daemon logging enabled).
  - Hover summary prompt: customize the prompt used for link hover summaries (prefilled; reset to default).
  - Pipeline mode: `page|url` (default auto).
  - Firecrawl: `off|auto|always`.
  - Markdown mode: `readability|llm|auto|off`.
- Preprocess: `off|auto|always`.
- YouTube mode: `no-auto|yt-dlp|web|apify` (default auto).
- Timeout (e.g. `90s`, `2m`), retries, max output tokens (e.g. `2k`).
- Process manager: live list of daemon-spawned tools (ffmpeg, yt-dlp, tesseract, etc.) with logs.
- Extension includes current settings in request; daemon treats them like CLI flags (`--model`, `--length`, `--language`, `--prompt`).

## Token Pairing / Setup Mode

Problem: daemon must be secured; extension must discover and pair with it.

- Side panel “Setup” state:
  - Generates token (random, 32+ bytes).
  - Shows:
    - `summarize daemon install --token <TOKEN>` (macOS: LaunchAgent, Linux: systemd user, Windows: Scheduled Task)
    - `summarize daemon status`
  - “Copy command” button.
- Daemon stores paired tokens in `~/.summarize/daemon.json`.
- Extension stores token in `chrome.storage.local`.
- If daemon unreachable or 401: show Setup state + troubleshooting.

## Daemon Endpoints

- `GET /health`
  - 200 JSON: `{ ok: true, pid }`
- `GET /v1/ping`
  - Requires auth; returns `{ ok: true }`
- `POST /v1/summarize`
  - Headers: `Authorization: Bearer <token>`
  - Body:
    - `url: string` (required)
    - `title: string | null`
    - `model?: string` (e.g. `auto`, `free`, `openai/gpt-5-mini`, ...)
    - `length?: string` (e.g. `short`, `xl`, `20k`)
    - `language?: string` (e.g. `auto`, `en`, `de`, `pt-BR`)
    - `prompt?: string` (custom instruction prefix)
    - `mode?: "auto" | "page" | "url"` (default: `"auto"`)
    - `maxCharacters?: number | null` (caps URL-mode extraction before summarization; ignored for extract-only unless explicitly provided)
    - `format?: "text" | "markdown"` (default: `"text"`)
    - `markdownMode?: "readability" | "auto" | "llm" | "off"` (only when `format: "markdown"`)
    - `preprocess?: "off" | "auto" | "always"` (markitdown/HTML preprocess)
    - `extractOnly?: boolean` (when `true`, returns extracted content without summarizing; requires `mode: "url"`)
    - `text?: string` (required for `mode: "page"`; optional for `auto`)
    - `truncated?: boolean` (optional; indicates extracted `text` was shortened)
  - 200 JSON: `{ ok: true, id }`
- `GET /v1/summarize/<id>/slides/events`
  - Headers: `Authorization: Bearer <token>`
  - SSE stream of slide updates (`slides`, `status`, `done`, `error`) independent of summary stream.
- `POST /v1/agent` (SSE by default; JSON via `Accept: application/json` or `?format=json`)
  - Headers: `Authorization: Bearer <token>`
  - Body:
    - `url: string` (required)
    - `title?: string | null`
    - `pageContent: string`
    - `cacheContent?: string` (used for cache key; defaults to `pageContent`)
    - `messages: Array<Message>` (pi-ai format)
    - `model?: string`
    - `length?: string` (e.g. `short`, `xl`, `20k`)
    - `language?: string` (e.g. `auto`, `en`, `de`)
    - `tools?: string[]`
    - `automationEnabled?: boolean`
  - SSE events:
    - `event: chunk` `data: { text }`
    - `event: assistant` `data: { ...assistant }`
    - `event: done` `data: {}`
    - `event: error` `data: { message }`
- `POST /v1/agent/history`
  - Headers: `Authorization: Bearer <token>`
  - Body:
    - `url: string` (required)
    - `pageContent: string`
    - `cacheContent?: string` (used for cache key; defaults to `pageContent`)
    - `model?: string`
    - `length?: string`
    - `language?: string`
    - `automationEnabled?: boolean`
  - 200 JSON: `{ ok: true, messages }`
- `GET /v1/summarize/:id/events` (SSE)
  - `event: chunk` `data: { text }`
  - `event: meta` `data: { model }`
  - `event: status` `data: { text }` (progress messages before output starts)
  - `event: metrics` `data: { elapsedMs, summary, details, summaryDetailed, detailsDetailed }`
  - `event: done` `data: {}`
  - `event: error` `data: { message }`

Notes:

- SSE keeps the extension simple + streaming-friendly.
- Requests keyed by `id`; daemon keeps a small in-memory map while streaming.

## Daemon Autostart

- CLI commands:
  - `summarize daemon install --token <token> [--port 8787]`
    - Writes `~/.summarize/daemon.json`
    - Installs platform autostart service; verifies `/health`
  - `summarize daemon uninstall`
  - `summarize daemon status`
  - `summarize daemon run` (foreground; used by autostart service)
- Ensure “single daemon”:
  - Stable service name + predictable unit/task path
  - `install` reuses the same daemon service and appends new tokens instead of invalidating older paired browsers

Platform details:

- macOS: LaunchAgent plist in `~/Library/LaunchAgents/<label>.plist`
- Linux: systemd user unit in `~/.config/systemd/user/summarize-daemon.service`
- Windows: Scheduled Task “Summarize Daemon” + `~/.summarize/daemon.cmd`

## Docs

- `docs/chrome-extension.md` (this file): architecture + setup + troubleshooting.
- Main `README.md`: link to extension doc and “Quickstart: 2 commands + load unpacked”.
- `apps/chrome-extension/README.md`: extension-specific dev/build/load-unpacked instructions.

## Status

- Implemented (daemon + CLI + Chrome extension).

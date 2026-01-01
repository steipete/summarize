# Summarize 👉 Point at any URL or file. Get the gist.

Fast summaries from URLs, files, and media. Works in the terminal, a Chrome Side Panel and Firefox Side Panel

## Big features

- URLs, files, and media: web pages, PDFs, images, audio/video, YouTube, podcasts, RSS.
- Real extraction pipeline: fetch -> clean -> Markdown (readability + markitdown), Firecrawl fallback when blocked.
- Transcript-first media flow: published transcripts when available, Whisper fallback when not.
- Streaming TTY output with Markdown rendering (markdansi) and scrollback-safe formatting.
- Local, paid, and free models: OpenAI-compatible local endpoints, paid providers, plus an OpenRouter free preset.
- Output modes: Markdown/text, JSON diagnostics, extract-only, metrics, timing, and cost estimates.

## Chrome Extension (Side Panel)

![Summarize extension screenshot](docs/assets/summarize-extension.png)

One-click summarizer for the current tab. Real Chrome Side Panel + local daemon for streaming Markdown.

Quickstart:

1) Install summarize (CLI + daemon):
   - `npm i -g @steipete/summarize`
   - `brew install steipete/tap/summarize` (macOS arm64)
2) Build + load the extension (unpacked):
   - `pnpm -C apps/chrome-extension build`
   - Chrome -> `chrome://extensions` -> Developer mode -> Load unpacked
   - Pick: `apps/chrome-extension/.output/chrome-mv3`
3) Open the Side Panel -> it shows a token + install command.
4) Run the install command in Terminal:
   - Installed binary: `summarize daemon install --token <TOKEN>`
   - Repo/dev checkout: `pnpm summarize daemon install --token <TOKEN> --dev`
5) Verify / debug:
   - `summarize daemon status`
   - `summarize daemon restart`

Notes:

- Summarization only runs when the Side Panel is open.
- Auto mode summarizes on navigation (incl. SPAs); otherwise use the button.
- Daemon is localhost-only and requires a shared token.
- Autostart: macOS (launchd), Linux (systemd user), Windows (Scheduled Task).
- Tip: configure `free` via `summarize refresh-free` (needs `OPENROUTER_API_KEY`). Add `--set-default` to set model=`free`.

More:

- Step-by-step install: [apps/chrome-extension/README.md](apps/chrome-extension/README.md)
- Architecture + troubleshooting: [docs/chrome-extension.md](docs/chrome-extension.md)

## CLI

![Summarize CLI screenshot](docs/assets/summarize-cli.png)

### Install

Requires Node 22+.

- npx (no install):

```bash
npx -y @steipete/summarize "https://example.com"
```

- npm (global):

```bash
npm i -g @steipete/summarize
```

- npm (library / minimal deps):

```bash
npm i @steipete/summarize-core
```

```ts
import { createLinkPreviewClient } from '@steipete/summarize-core/content'
```

- Homebrew (custom tap):

```bash
brew install steipete/tap/summarize
```

Apple Silicon only (arm64).

### Quickstart

```bash
summarize "https://example.com"
```

### Inputs

URLs or local paths:

```bash
summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview
summarize "https://example.com/report.pdf" --model google/gemini-3-flash-preview
```

YouTube (supports `youtube.com` and `youtu.be`):

```bash
summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto
```

Podcast RSS (transcribes latest enclosure):

```bash
summarize "https://feeds.npr.org/500005/podcast.xml"
```

Apple Podcasts episode page:

```bash
summarize "https://podcasts.apple.com/us/podcast/2424-jelly-roll/id360084272?i=1000740717432"
```

Spotify episode page (best-effort; may fail for exclusives):

```bash
summarize "https://open.spotify.com/episode/5auotqWAXhhKyb9ymCuBJY"
```

### Output length

`--length` controls how much output we ask for (guideline), not a hard cap.

```bash
summarize "https://example.com" --length long
summarize "https://example.com" --length 20k
```

- Presets: `short|medium|long|xl|xxl`
- Character targets: `1500`, `20k`, `20000`
- Optional hard cap: `--max-output-tokens <count>` (e.g. `2000`, `2k`)
  - Provider/model APIs still enforce their own maximum output limits.
  - If omitted, no max token parameter is sent (provider default).
  - Prefer `--length` unless you need a hard cap.
- Minimums: `--length` numeric values must be >= 50 chars; `--max-output-tokens` must be >= 16.
- Preset targets (source of truth: `packages/core/src/prompts/summary-lengths.ts`):
  - short: target ~900 chars (range 600-1,200)
  - medium: target ~1,800 chars (range 1,200-2,500)
  - long: target ~4,200 chars (range 2,500-6,000)
  - xl: target ~9,000 chars (range 6,000-14,000)
  - xxl: target ~17,000 chars (range 14,000-22,000)

### What file types work?

Best effort and provider-dependent. These usually work well:

- `text/*` and common structured text (`.txt`, `.md`, `.json`, `.yaml`, `.xml`, ...)
  - Text-like files are inlined into the prompt for better provider compatibility.
- PDFs: `application/pdf` (provider support varies; Google is the most reliable here)
- Images: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- Audio/Video: `audio/*`, `video/*` (when supported by the model)

Notes:

- If a provider rejects a media type, the CLI fails fast with a friendly message.
- xAI models do not support attaching generic files (like PDFs) via the AI SDK; use Google/OpenAI/Anthropic for those.

### Model ids

Use gateway-style ids: `<provider>/<model>`.

Examples:

- `openai/gpt-5-mini`
- `anthropic/claude-sonnet-4-5`
- `xai/grok-4-fast-non-reasoning`
- `google/gemini-3-flash-preview`
- `zai/glm-4.7`
- `openrouter/openai/gpt-5-mini` (force OpenRouter)

Note: some models/providers do not support streaming or certain file media types. When that happens, the CLI prints a friendly error (or auto-disables streaming for that model when supported by the provider).

### Limits

- Text inputs over 10 MB are rejected before tokenization.
- Text prompts are preflighted against the model input limit (LiteLLM catalog), using a GPT tokenizer.

### Common flags

```bash
summarize <input> [flags]
```

Use `summarize --help` or `summarize help` for the full help text.

- `--model <provider/model>`: which model to use (defaults to `auto`)
- `--model auto`: automatic model selection + fallback (default)
- `--model <name>`: use a config-defined model (see Configuration)
- `--timeout <duration>`: `30s`, `2m`, `5000ms` (default `2m`)
- `--retries <count>`: LLM retry attempts on timeout (default `1`)
- `--length short|medium|long|xl|xxl|s|m|l|<chars>`
- `--language, --lang <language>`: output language (`auto` = match source)
- `--max-output-tokens <count>`: hard cap for LLM output tokens
- `--cli [provider]`: use a CLI provider (`--model cli/<provider>`). If omitted, uses auto selection with CLI enabled.
- `--stream auto|on|off`: stream LLM output (`auto` = TTY only; disabled in `--json` mode)
- `--plain`: keep raw output (no ANSI/OSC Markdown rendering)
- `--no-color`: disable ANSI colors
- `--format md|text`: website/file content format (default `text`)
- `--markdown-mode off|auto|llm|readability`: HTML -> Markdown mode (default `readability`)
- `--preprocess off|auto|always`: controls `uvx markitdown` usage (default `auto`)
  - Install `uvx`: `brew install uv` (or https://astral.sh/uv/)
- `--extract`: print extracted content and exit (URLs only)
  - Deprecated alias: `--extract-only`
- `--json`: machine-readable output with diagnostics, prompt, `metrics`, and optional summary
- `--verbose`: debug/diagnostics on stderr
- `--metrics off|on|detailed`: metrics output (default `on`)

### Auto model ordering

`--model auto` builds candidate attempts from built-in rules (or your `model.rules` overrides).
CLI tools are not used in auto mode unless you enable them via `cli.enabled` in config.
Why: CLI adds ~4s latency per attempt and higher variance.
Shortcut: `--cli` (with no provider) uses auto selection with CLI enabled.

When enabled, auto prepends CLI attempts in the order listed in `cli.enabled`
(recommended: `["gemini"]`), then tries the native provider candidates
(with OpenRouter fallbacks when configured).

Enable CLI attempts:

```json
{
  "cli": { "enabled": ["gemini"] }
}
```

Disable CLI attempts:

```json
{
  "cli": { "enabled": [] }
}
```

Note: when `cli.enabled` is set, it is also an allowlist for explicit `--cli` / `--model cli/...`.

### Website extraction (Firecrawl + Markdown)

Non-YouTube URLs go through a fetch -> extract pipeline. When direct fetch/extraction is blocked or too thin,
`--firecrawl auto` can fall back to Firecrawl (if configured).

- `--firecrawl off|auto|always` (default `auto`)
- `--extract --format md|text` (default `text`; if `--format` is omitted, `--extract` defaults to `md` for non-YouTube URLs)
- `--markdown-mode off|auto|llm|readability` (default `readability`)
  - `auto`: use an LLM converter when configured; may fall back to `uvx markitdown`
  - `llm`: force LLM conversion (requires a configured model key)
  - `off`: disable LLM conversion (still may return Firecrawl Markdown when configured)
- Plain-text mode: use `--format text`.

### YouTube transcripts

`--youtube auto` tries best-effort web transcript endpoints first. When captions are not available, it falls back to:

1. Apify (if `APIFY_API_TOKEN` is set): uses a scraping actor (`faVsWy9VTSNVIhWpR`)
2. yt-dlp + Whisper (if `yt-dlp` is available): downloads audio, then transcribes with local `whisper.cpp` when installed
   (preferred), otherwise falls back to OpenAI (`OPENAI_API_KEY`) or FAL (`FAL_KEY`)

Environment variables for yt-dlp mode:

- `YT_DLP_PATH` - optional path to yt-dlp binary (otherwise `yt-dlp` is resolved via `PATH`)
- `SUMMARIZE_WHISPER_CPP_MODEL_PATH` - optional override for the local `whisper.cpp` model file
- `SUMMARIZE_WHISPER_CPP_BINARY` - optional override for the local binary (default: `whisper-cli`)
- `SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP=1` - disable local whisper.cpp (force remote)
- `OPENAI_API_KEY` - OpenAI Whisper transcription
- `FAL_KEY` - FAL AI Whisper fallback

Apify costs money but tends to be more reliable when captions exist.

Format the extracted transcript as Markdown (headings + paragraphs) via an LLM:

```bash
summarize "https://www.youtube.com/watch?v=..." --extract --format md --markdown-mode llm
```

### Media transcription (Whisper)

`--video-mode transcript` forces audio/video inputs (local files or direct media URLs) through Whisper first,
then summarizes the transcript text. Prefers local `whisper.cpp` when available; otherwise requires
`OPENAI_API_KEY` or `FAL_KEY`.

### Verified podcast services (2025-12-25)

Run: `summarize <url>`

- Apple Podcasts
- Spotify
- Amazon Music / Audible podcast pages
- Podbean
- Podchaser
- RSS feeds (Podcasting 2.0 transcripts when available)
- Embedded YouTube podcast pages (e.g. JREPodcast)

Transcription: prefers local `whisper.cpp` when installed; otherwise uses OpenAI Whisper or FAL when keys are set.

### Translation paths

`--language/--lang` controls the output language of the summary (and other LLM-generated text). Default is `auto`.

When the input is audio/video, the CLI needs a transcript first. The transcript comes from one of these paths:

1. Existing transcript (preferred)
   - YouTube: uses `youtubei` / `captionTracks` when available.
   - Podcasts: uses Podcasting 2.0 RSS `<podcast:transcript>` (JSON/VTT) when the feed publishes it.
2. Whisper transcription (fallback)
   - YouTube: falls back to yt-dlp (audio download) + Whisper transcription when configured; Apify is a last resort.
   - Prefers local `whisper.cpp` when installed + model available.
   - Otherwise uses cloud Whisper (OpenAI `OPENAI_API_KEY`) or FAL (`FAL_KEY`).

For "any video/audio file" (local path or direct media URL), use `--video-mode transcript` to force
transcribe -> summarize:

```bash
summarize /path/to/file.mp4 --video-mode transcript --lang en
```

### Configuration

Single config location:

- `~/.summarize/config.json`

Supported keys today:

```json
{
  "model": { "id": "openai/gpt-5-mini" }
}
```

Shorthand (equivalent):

```json
{
  "model": "openai/gpt-5-mini"
}
```

Also supported:

- `model: { "mode": "auto" }` (automatic model selection + fallback; see [docs/model-auto.md](docs/model-auto.md))
- `model.rules` (customize candidates / ordering)
- `models` (define presets selectable via `--model <preset>`)
- `media.videoMode: "auto"|"transcript"|"understand"`
- `openai.useChatCompletions: true` (force OpenAI-compatible chat completions)

Note: the config is parsed leniently (JSON5), but comments are not allowed. Unknown keys are ignored.

Precedence:

1) `--model`
2) `SUMMARIZE_MODEL`
3) `~/.summarize/config.json`
4) default (`auto`)

### Environment variables

Set the key matching your chosen `--model`:

- `OPENAI_API_KEY` (for `openai/...`)
- `ANTHROPIC_API_KEY` (for `anthropic/...`)
- `XAI_API_KEY` (for `xai/...`)
- `Z_AI_API_KEY` (for `zai/...`; supports `ZAI_API_KEY` alias)
- `GEMINI_API_KEY` (for `google/...`)
  - also accepts `GOOGLE_GENERATIVE_AI_API_KEY` and `GOOGLE_API_KEY` as aliases

OpenAI-compatible chat completions toggle:

- `OPENAI_USE_CHAT_COMPLETIONS=1` (or set `openai.useChatCompletions` in config)

OpenRouter (OpenAI-compatible):

- Set `OPENROUTER_API_KEY=...`
- Prefer forcing OpenRouter per model id: `--model openrouter/<author>/<slug>`
- Built-in preset: `--model free` (uses a default set of OpenRouter `:free` models)

### `summarize refresh-free`

Quick start: make free the default (keep `auto` available)

```bash
summarize refresh-free --set-default
summarize "https://example.com"
summarize "https://example.com" --model auto
```

Regenerates the `free` preset (`models.free` in `~/.summarize/config.json`) by:

- Fetching OpenRouter `/models`, filtering `:free`
- Skipping models that look very small (<27B by default) based on the model id/name
- Testing which ones return non-empty text (concurrency 4, timeout 10s)
- Picking a mix of smart-ish (bigger `context_length` / output cap) and fast models
- Refining timings and writing the sorted list back

If `--model free` stops working, run:

```bash
summarize refresh-free
```

Flags:

- `--runs 2` (default): extra timing runs per selected model (total runs = 1 + runs)
- `--smart 3` (default): how many smart-first picks (rest filled by fastest)
- `--min-params 27b` (default): ignore models with inferred size smaller than N billion parameters
- `--max-age-days 180` (default): ignore models older than N days (set 0 to disable)
- `--set-default`: also sets `"model": "free"` in `~/.summarize/config.json`

Example:

```bash
OPENROUTER_API_KEY=sk-or-... summarize "https://example.com" --model openrouter/meta-llama/llama-3.1-8b-instruct:free
```

If your OpenRouter account enforces an allowed-provider list, make sure at least one provider
is allowed for the selected model. When routing fails, `summarize` prints the exact providers to allow.

Legacy: `OPENAI_BASE_URL=https://openrouter.ai/api/v1` (and either `OPENAI_API_KEY` or `OPENROUTER_API_KEY`) also works.

Z.AI (OpenAI-compatible):

- `Z_AI_API_KEY=...` (or `ZAI_API_KEY=...`)
- Optional base URL override: `Z_AI_BASE_URL=...`

Optional services:

- `FIRECRAWL_API_KEY` (website extraction fallback)
- `YT_DLP_PATH` (path to yt-dlp binary for audio extraction)
- `FAL_KEY` (FAL AI API key for audio transcription via Whisper)
- `APIFY_API_TOKEN` (YouTube transcript fallback)

### Model limits

The CLI uses the LiteLLM model catalog for model limits (like max output tokens):

- Downloaded from: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- Cached at: `~/.summarize/cache/`

### Library usage (optional)

Recommended (minimal deps):

- `@steipete/summarize-core/content`
- `@steipete/summarize-core/prompts`

Compatibility (pulls in CLI deps):

- `@steipete/summarize/content`
- `@steipete/summarize/prompts`

### Development

```bash
pnpm install
pnpm check
```

## More

- Docs index: [docs/README.md](docs/README.md)
- CLI providers and config: [docs/cli.md](docs/cli.md)
- Auto model rules: [docs/model-auto.md](docs/model-auto.md)
- Website extraction: [docs/website.md](docs/website.md)
- YouTube handling: [docs/youtube.md](docs/youtube.md)
- Media pipeline: [docs/media.md](docs/media.md)
- Config schema and precedence: [docs/config.md](docs/config.md)

## Troubleshooting

- "Receiving end does not exist": Chrome did not inject the content script yet.
  - Extension details -> Site access -> On all sites (or allow this domain)
  - Reload the tab once.
- "Failed to fetch" / daemon unreachable:
  - `summarize daemon status`
  - Logs: `~/.summarize/logs/daemon.err.log`

License: MIT

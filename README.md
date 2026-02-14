# Summarize 📝 — Chrome Side Panel + CLI

![GitHub Repo Banner](https://ghrb.waren.build/banner?header=Summarize%F0%9F%93%9D&subheader=Chrome+Side+Panel+%2B+CLI&bg=f3f4f6&color=1f2937&support=true)

<!-- Created with GitHub Repo Banner by Waren Gonzaga: https://ghrb.waren.build -->

Fast summaries from URLs, files, and media. Works in the terminal, a Chrome Side Panel and Firefox Sidebar.

**0.11.0 preview (unreleased):** this README reflects the upcoming release.

## 0.11.0 preview highlights (most interesting first)

- Chrome Side Panel **chat** (streaming agent + history) inside the sidebar.
- **YouTube slides**: screenshots + OCR + transcript cards, timestamped seek, OCR/Transcript toggle.
- Media-aware summaries: auto‑detect video/audio vs page content.
- Streaming Markdown + metrics + cache‑aware status.
- CLI supports URLs, files, podcasts, YouTube, audio/video, PDFs.

## Feature overview

- URLs, files, and media: web pages, PDFs, images, audio/video, YouTube, podcasts, RSS.
- Slide extraction for video sources (YouTube/direct media) with OCR + timestamped cards.
- Transcript-first media flow: published transcripts when available, Whisper fallback when not.
- Streaming output with Markdown rendering, metrics, and cache-aware status.
- Local, paid, and free models: OpenAI‑compatible local endpoints, paid providers, plus an OpenRouter free preset.
- Output modes: Markdown/text, JSON diagnostics, extract-only, metrics, timing, and cost estimates.
- Smart default: if content is shorter than the requested length, we return it as-is (use `--force-summary` to override).

## Get the extension (recommended)

![Summarize extension screenshot](docs/assets/summarize-extension.png)

One‑click summarizer for the current tab. Chrome Side Panel + Firefox Sidebar + local daemon for streaming Markdown.

**Chrome Web Store:** [Summarize Side Panel](https://chromewebstore.google.com/detail/summarize/cejgnmmhbbpdmjnfppjdfkocebngehfg)

YouTube slide screenshots (from the browser):

![Summarize YouTube slide screenshots](docs/assets/youtube-slides.png)

### Beginner quickstart (extension)

1. Install the CLI (choose one):
   - **npm** (cross‑platform): `npm i -g @steipete/summarize`
   - **Homebrew** (macOS arm64): `brew install steipete/tap/summarize`
2. Install the extension (Chrome Web Store link above) and open the Side Panel.
3. The panel shows a token + install command. Run it in Terminal:
   - `summarize daemon install --token <TOKEN>`

Why a daemon/service?

- The extension can’t run heavy extraction inside the browser. It talks to a local background service on `127.0.0.1` for fast streaming and media tools (yt‑dlp, ffmpeg, OCR, transcription).
- The service autostarts (launchd/systemd/Scheduled Task) so the Side Panel is always ready.

If you only want the **CLI**, you can skip the daemon install entirely.

Notes:

- Summarization only runs when the Side Panel is open.
- Auto mode summarizes on navigation (incl. SPAs); otherwise use the button.
- Daemon is localhost-only and requires a shared token.
- Autostart: macOS (launchd), Linux (systemd user), Windows (Scheduled Task).
- Tip: configure `free` via `summarize refresh-free` (needs `OPENROUTER_API_KEY`). Add `--set-default` to set model=`free`.

More:

- Step-by-step install: [apps/chrome-extension/README.md](apps/chrome-extension/README.md)
- Architecture + troubleshooting: [docs/chrome-extension.md](docs/chrome-extension.md)
- Firefox compatibility notes: [apps/chrome-extension/docs/firefox.md](apps/chrome-extension/docs/firefox.md)

### Slides (extension)

- Select **Video + Slides** in the Summarize picker.
- Slides render at the top; expand to full‑width cards with timestamps.
- Click a slide to seek the video; toggle **Transcript/OCR** when OCR is significant.
- Requirements: `yt-dlp` + `ffmpeg` for extraction; `tesseract` for OCR. Missing tools show an in‑panel notice.

### Advanced (unpacked / dev)

1. Build + load the extension (unpacked):
   - Chrome: `pnpm -C apps/chrome-extension build`
     - `chrome://extensions` → Developer mode → Load unpacked
     - Pick: `apps/chrome-extension/.output/chrome-mv3`
   - Firefox: `pnpm -C apps/chrome-extension build:firefox`
     - `about:debugging#/runtime/this-firefox` → Load Temporary Add-on
     - Pick: `apps/chrome-extension/.output/firefox-mv3/manifest.json`
2. Open Side Panel/Sidebar → copy token.
3. Install daemon in dev mode:
   - `pnpm summarize daemon install --token <TOKEN> --dev`

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
import { createLinkPreviewClient } from "@steipete/summarize-core/content";
```

- Homebrew (custom tap):

```bash
brew install steipete/tap/summarize
```

Apple Silicon only (arm64).

### CLI vs extension

- **CLI only:** just install via npm/Homebrew and run `summarize ...` (no daemon needed).
- **Chrome/Firefox extension:** install the CLI **and** run `summarize daemon install --token <TOKEN>` so the Side Panel can stream results and use local tools.

### Quickstart

```bash
summarize "https://example.com"
```

### Inputs

URLs or local paths:

```bash
summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview
summarize "https://example.com/report.pdf" --model google/gemini-3-flash-preview
summarize "/path/to/audio.mp3"
summarize "/path/to/video.mp4"
```

Stdin (pipe content using `-`):

```bash
echo "content" | summarize -
pbpaste | summarize -
# binary stdin also works (PDF/image/audio/video bytes)
cat /path/to/file.pdf | summarize -
```

**Notes:**

- Stdin has a 50MB size limit
- The `-` argument tells summarize to read from standard input
- Text stdin is treated as UTF-8 text (whitespace-only input is rejected as empty)
- Binary stdin is preserved as raw bytes and file type is auto-detected when possible
- Useful for piping clipboard content or command output

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
- Short content: when extracted content is shorter than the requested length, the CLI returns the content as-is.
  - Override with `--force-summary` to always run the LLM.
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
- Audio/Video: `audio/*`, `video/*` (local audio/video files MP3/WAV/M4A/OGG/FLAC/MP4/MOV/WEBM automatically transcribed, when supported by the model)

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
- `--cli [provider]`: use a CLI provider (`--model cli/<provider>`). Supports `claude`, `gemini`, `codex`, `agent`. If omitted, uses auto selection with CLI enabled.
- `--stream auto|on|off`: stream LLM output (`auto` = TTY only; disabled in `--json` mode)
- `--plain`: keep raw output (no ANSI/OSC Markdown rendering)
- `--no-color`: disable ANSI colors
- `--theme <name>`: CLI theme (`aurora`, `ember`, `moss`, `mono`)
- `--format md|text`: website/file content format (default `text`)
- `--markdown-mode off|auto|llm|readability`: HTML -> Markdown mode (default `readability`)
- `--preprocess off|auto|always`: controls `uvx markitdown` usage (default `auto`)
  - Install `uvx`: `brew install uv` (or https://astral.sh/uv/)
- `--extract`: print extracted content and exit (URLs only; stdin `-` is not supported)
  - Deprecated alias: `--extract-only`
- `--slides`: extract slides for YouTube/direct video URLs and render them inline in the summary narrative (auto-renders inline in supported terminals)
- `--slides-ocr`: run OCR on extracted slides (requires `tesseract`)
- `--slides-dir <dir>`: base output dir for slide images (default `./slides`)
- `--slides-scene-threshold <value>`: scene detection threshold (0.1-1.0)
- `--slides-max <count>`: maximum slides to extract (default `6`)
- `--slides-min-duration <seconds>`: minimum seconds between slides
- `--json`: machine-readable output with diagnostics, prompt, `metrics`, and optional summary
- `--verbose`: debug/diagnostics on stderr
- `--metrics off|on|detailed`: metrics output (default `on`)

### Coding CLIs (Codex, Claude, Gemini, Agent)

Summarize can use common coding CLIs as local model backends:

- `codex` -> `--cli codex` / `--model cli/codex/<model>`
- `claude` -> `--cli claude` / `--model cli/claude/<model>`
- `gemini` -> `--cli gemini` / `--model cli/gemini/<model>`
- `agent` (Cursor Agent CLI) -> `--cli agent` / `--model cli/agent/<model>`

Requirements:

- Binary installed and on `PATH` (or set `CODEX_PATH`, `CLAUDE_PATH`, `GEMINI_PATH`, `AGENT_PATH`)
- Provider authenticated (`codex login`, `claude auth`, `gemini` login flow, `agent login` or `CURSOR_API_KEY`)

Quick smoke test:

```bash
printf "Summarize CLI smoke input.\nOne short paragraph. Reply can be brief.\n" >/tmp/summarize-cli-smoke.txt

summarize --cli codex --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli claude --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli gemini --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli agent --plain --timeout 2m /tmp/summarize-cli-smoke.txt
```

Set explicit CLI allowlist/order:

```json
{
  "cli": { "enabled": ["codex", "claude", "gemini", "agent"] }
}
```

Configure implicit auto CLI fallback:

```json
{
  "cli": {
    "autoFallback": {
      "enabled": true,
      "onlyWhenNoApiKeys": true,
      "order": ["claude", "gemini", "codex", "agent"]
    }
  }
}
```

More details: [`docs/cli.md`](docs/cli.md)

### Auto model ordering

`--model auto` builds candidate attempts from built-in rules (or your `model.rules` overrides).
CLI attempts are prepended when:

- `cli.enabled` is set (explicit allowlist/order), or
- implicit auto selection is active and `cli.autoFallback` is enabled.

Default fallback behavior: only when no API keys are configured, order `claude, gemini, codex, agent`, and remember/prioritize last successful provider (`~/.summarize/cli-state.json`).

Set explicit CLI attempts:

```json
{
  "cli": { "enabled": ["gemini"] }
}
```

Disable implicit auto CLI fallback:

```json
{
  "cli": { "autoFallback": { "enabled": false } }
}
```

Note: explicit `--model auto` does not trigger implicit auto CLI fallback unless `cli.enabled` is set.

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
- `OPENAI_WHISPER_BASE_URL` - optional OpenAI-compatible Whisper endpoint override
- `FAL_KEY` - FAL AI Whisper fallback

Apify costs money but tends to be more reliable when captions exist.

### Slide extraction (YouTube + direct video URLs)

Extract slide screenshots (scene detection via `ffmpeg`) and optional OCR:

```bash
summarize "https://www.youtube.com/watch?v=..." --slides
summarize "https://www.youtube.com/watch?v=..." --slides --slides-ocr
```

Outputs are written under `./slides/<sourceId>/` (or `--slides-dir`). OCR results are included in JSON output
(`--json`) and stored in `slides.json` inside the slide directory. When scene detection is too sparse, the
extractor also samples at a fixed interval to improve coverage.
When using `--slides`, supported terminals (kitty/iTerm/Konsole) render inline thumbnails automatically inside the
summary narrative (the model inserts `[slide:N]` markers). Timestamp links are clickable when the terminal supports
OSC-8 (YouTube/Vimeo/Loom/Dropbox). If inline images are unsupported, Summarize prints a note with the on-disk
slide directory.

Use `--slides --extract` to print the full timed transcript and insert slide images inline at matching timestamps.

Format the extracted transcript as Markdown (headings + paragraphs) via an LLM:

```bash
summarize "https://www.youtube.com/watch?v=..." --extract --format md --markdown-mode llm
```

### Media transcription (Whisper)

Local audio/video files are transcribed first, then summarized. `--video-mode transcript` forces
direct media URLs (and embedded media) through Whisper first. Prefers local `whisper.cpp` when available; otherwise requires
`OPENAI_API_KEY` or `FAL_KEY`.

### Local ONNX transcription (Parakeet/Canary)

Summarize can use NVIDIA Parakeet/Canary ONNX models via a local CLI you provide. Auto selection (default) prefers ONNX when configured.

- Setup helper: `summarize transcriber setup`
- Install `sherpa-onnx` from upstream binaries/build (Homebrew may not have a formula)
- Auto selection: set `SUMMARIZE_ONNX_PARAKEET_CMD` or `SUMMARIZE_ONNX_CANARY_CMD` (no flag needed)
- Force a model: `--transcriber parakeet|canary|whisper|auto`
- Docs: `docs/nvidia-onnx-transcription.md`

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

For direct media URLs, use `--video-mode transcript` to force transcribe -> summarize:

```bash
summarize https://example.com/file.mp4 --video-mode transcript --lang en
```

### Configuration

Single config location:

- `~/.summarize/config.json`

Supported keys today:

```json
{
  "model": { "id": "openai/gpt-5-mini" },
  "env": { "OPENAI_API_KEY": "sk-..." },
  "ui": { "theme": "ember" }
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
- `env` (generic env var defaults; process env still wins)
- `apiKeys` (legacy shortcut, mapped to env names; prefer `env` for new configs)
- `cache.media` (media download cache: TTL 7 days, 2048 MB cap by default; `--no-media-cache` disables)
- `media.videoMode: "auto"|"transcript"|"understand"`
- `slides.enabled` / `slides.max` / `slides.ocr` / `slides.dir` (defaults for `--slides`)
- `ui.theme: "aurora"|"ember"|"moss"|"mono"`
- `openai.useChatCompletions: true` (force OpenAI-compatible chat completions)

Note: the config is parsed leniently (JSON5), but comments are not allowed. Unknown keys are ignored.

Media cache defaults:

```json
{
  "cache": {
    "media": { "enabled": true, "ttlDays": 7, "maxMb": 2048, "verify": "size" }
  }
}
```

Note: `--no-cache` bypasses summary caching only (LLM output). Extract/transcript caches still apply. Use `--no-media-cache` to skip media files.

Precedence:

1. `--model`
2. `SUMMARIZE_MODEL`
3. `~/.summarize/config.json`
4. default (`auto`)

Theme precedence:

1. `--theme`
2. `SUMMARIZE_THEME`
3. `~/.summarize/config.json` (`ui.theme`)
4. default (`aurora`)

Environment variable precedence:

1. process env
2. `~/.summarize/config.json` (`env`)
3. `~/.summarize/config.json` (`apiKeys`, legacy)

### Environment variables

Set the key matching your chosen `--model`:

- Optional fallback defaults can be stored in config:
  - `~/.summarize/config.json` -> `"env": { "OPENAI_API_KEY": "sk-..." }`
  - process env always takes precedence
  - legacy `"apiKeys"` still works (mapped to env names)

- `OPENAI_API_KEY` (for `openai/...`)
- `NVIDIA_API_KEY` (for `nvidia/...`)
- `ANTHROPIC_API_KEY` (for `anthropic/...`)
- `XAI_API_KEY` (for `xai/...`)
- `Z_AI_API_KEY` (for `zai/...`; supports `ZAI_API_KEY` alias)
- `GEMINI_API_KEY` (for `google/...`)
  - also accepts `GOOGLE_GENERATIVE_AI_API_KEY` and `GOOGLE_API_KEY` as aliases

OpenAI-compatible chat completions toggle:

- `OPENAI_USE_CHAT_COMPLETIONS=1` (or set `openai.useChatCompletions` in config)

UI theme:

- `SUMMARIZE_THEME=aurora|ember|moss|mono`
- `SUMMARIZE_TRUECOLOR=1` (force 24-bit ANSI)
- `SUMMARIZE_NO_TRUECOLOR=1` (disable 24-bit ANSI)

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
OPENROUTER_API_KEY=sk-or-... summarize "https://example.com" --model openrouter/minimax/minimax-m2.5
```

If your OpenRouter account enforces an allowed-provider list, make sure at least one provider
is allowed for the selected model. When routing fails, `summarize` prints the exact providers to allow.

Legacy: `OPENAI_BASE_URL=https://openrouter.ai/api/v1` (and either `OPENAI_API_KEY` or `OPENROUTER_API_KEY`) also works.

NVIDIA API Catalog (OpenAI-compatible; free credits):

- Set `NVIDIA_API_KEY=...`
- Optional: `NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1`
- Credits: API Catalog trial starts with 1000 free API credits on signup (up to 5000 total via “Request More” in the API Catalog profile)
- Pick a model id from `/v1/models` (examples: fast `stepfun-ai/step-3.5-flash`, strong but slower `z-ai/glm5`)

```bash
export NVIDIA_API_KEY="nvapi-..."
summarize "https://example.com" --model nvidia/stepfun-ai/step-3.5-flash
```

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

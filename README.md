# Summarize 📝 — Chrome Side Panel + CLI

Fast summaries from URLs, files, and media. Works in the terminal, a Chrome Side Panel and Firefox Sidebar.

## Highlights

- Chrome Side Panel **chat** (streaming agent + history) inside the sidebar.
- **Video slides**: screenshots + OCR + transcript cards for YouTube, direct video URLs, and local video files.
- Media-aware summaries: auto‑detect video/audio vs page content.
- Coding CLI backends: Codex, Claude, Gemini, Cursor Agent, OpenClaw, OpenCode, GitHub Copilot, Antigravity, pi.
- Streaming Markdown + metrics + cache‑aware status.
- CLI supports URLs, files, podcasts, YouTube, audio/video, PDFs.

## Feature overview

- URLs, files, and media: web pages, PDFs, images, audio/video, YouTube, podcasts, RSS.
- Slide extraction for video sources (YouTube, direct video URLs, local video files) with OCR + timestamped cards.
- Transcript-first media flow: published transcripts when available, then Groq/ONNX/whisper.cpp/AssemblyAI/Gemini/OpenAI/FAL/Deepgram transcription fallback when not.
- Coding CLI providers: Claude, Codex, Gemini, Cursor Agent, OpenClaw, OpenCode, GitHub Copilot, Antigravity, pi.
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

1. Install the extension (Chrome Web Store link above) and open the Side Panel.
2. Choose **Direct** or **Daemon**. Direct uses Gemini Nano by default when no provider key is configured, or calls your selected provider from Chrome.
3. Choose Browser media for daemonless transcription/slides. Optional: install the CLI and pair the daemon for native tools, CLI model fallbacks, OCR, and broader media support:
   - **npm** (cross-platform): `npm i -g @steipete/summarize`
   - **Homebrew** (Homebrew/core): `brew install summarize`
   - `summarize daemon install --token <TOKEN> --port 8787`

Why a daemon/service?

- Direct mode works without the daemon. Auto uses a configured OpenAI, OpenRouter, Anthropic, Gemini, xAI, Z.AI, NVIDIA, MiniMax, GitHub Models, or Ollama provider, otherwise Gemini Nano on-device; keys remain in extension-local storage.
- The optional daemon adds CLI model fallbacks, shared caches/diagnostics, native ffmpeg, configurable transcription providers, OCR, and broader media support. Chrome reaches it through an explicitly enabled Native Messaging host; retained loopback network access is used only by configured Direct local providers.
- The service autostarts (launchd/systemd/Scheduled Task) so the Side Panel is always ready.

If you only want the **CLI**, you can skip the daemon install entirely.

Notes:

- Summarization only runs when the Side Panel is open.
- Auto mode summarizes on navigation (incl. SPAs); otherwise use the button.
- Daemon is localhost-only and requires a shared token; rerunning `summarize daemon install --token <TOKEN>` adds another paired browser token instead of invalidating the old one.
- Chrome local-companion access is optional and browser-policy enforceable; Direct and Browser modes do not require it.
- Non-default port: install with `summarize daemon install --token <TOKEN> --port <PORT>`, then set the same value in **Options → Runtime → Daemon → Port**.
- Autostart: macOS (launchd), Linux (systemd user), Windows (Scheduled Task).
- Windows containers: `summarize daemon install` starts the daemon for the current container session but does not register a Scheduled Task. Chrome Daemon mode also needs the pending packaged Windows native-host executable; Direct and Browser modes remain available.
- Tip: configure `free` via `summarize refresh-free` (needs `OPENROUTER_API_KEY`). Add `--set-default` to set model=`free`.

More:

- Step-by-step install: [apps/chrome-extension/README.md](apps/chrome-extension/README.md)
- Architecture + troubleshooting: [docs/chrome-extension.md](docs/chrome-extension.md)
- Firefox compatibility notes: [apps/chrome-extension/docs/firefox.md](apps/chrome-extension/docs/firefox.md)

### Slides (extension)

- Select **Video + Slides** in the Summarize picker.
- Slides render at the top; expand to full‑width cards with timestamps.
- Click a slide to seek the video; toggle **Transcript/OCR** when OCR is significant.
- Browser mode uses MediaBunny with native WebCodecs and ranged network reads for fetchable videos, then falls back to visible-tab capture when the source or codec is unavailable.
- Daemon mode adds `yt-dlp`, native ffmpeg, and optional `tesseract` OCR.

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
   - `pnpm summarize daemon install --token <TOKEN> --dev --extension-id <UNPACKED_ID>`

## CLI

![Summarize CLI screenshot](docs/assets/summarize-cli.png)

### Install

Requires Node 24+.

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

- Homebrew:

```bash
brew install summarize
```

Homebrew ships from `homebrew/core` via `brew install summarize`.
If Homebrew is unavailable in your environment, use the npm global install above.

### Optional local dependencies

Install these if you want media-heavy features:

- `ffmpeg`: optional native accelerator with broader codec support; bundled WebAssembly is the fallback
- `yt-dlp`: required for YouTube slide extraction and some remote media flows
- `tesseract`: optional OCR for `--slides-ocr`
- Optional cloud transcription providers:
  - `GROQ_API_KEY`
  - `ASSEMBLYAI_API_KEY`
  - `ELEVENLABS_API_KEY` (speaker diarization)
  - `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`
  - `OPENAI_API_KEY`
  - `FAL_KEY`
  - `DEEPGRAM_API_KEY`

macOS (Homebrew):

```bash
brew install ffmpeg yt-dlp
brew install tesseract # optional, for --slides-ocr
```

If native `ffmpeg`/`ffprobe` are unavailable, Summarize uses the bundled WebAssembly build. Native ffmpeg remains recommended for speed and broader codec/filter support.

### CLI vs extension

- **CLI only:** just install via npm/Homebrew and run `summarize ...` (no daemon needed).
- **Chrome extension:** Direct mode defaults to Gemini Nano without a key and supports provider-backed summaries/chat/automation/hover when configured; Browser media provides daemonless transcription and slides. Install the daemon for CLI fallbacks and native media tools.
- **Firefox extension:** install the CLI and daemon for media extraction.

### Quickstart

```bash
summarize "https://example.com"
```

Inspect the effective model setup. Status only lists configured or usable providers; it never prints
keys or missing-provider noise.

```bash
summarize status
summarize status --verbose
summarize status --probe
summarize status --json
```

`--probe` checks supported model-list endpoints without running paid inference. CLI providers are
reported as available when their enabled executable is present; API providers are reported as
configured when an effective key is present.

### Inputs

URLs or local paths:

```bash
summarize "/path/to/file.pdf" --model google/gemini-3-flash
summarize "https://example.com/report.pdf" --model google/gemini-3-flash
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

HLS playlist:

```bash
summarize "https://example.com/master.m3u8"
```

### Output length

`--length` controls how much output we ask for (guideline), not a hard cap.
The built-in default is `long`.

Set a default in `~/.summarize/config.json` with `output.length`.

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
- Minimums: `--length` numeric values must be >= 10 chars; `--max-output-tokens` must be >= 16.
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

- `openai/gpt-5.4`
- `openai/gpt-5.4-mini`
- `openai/gpt-5.4-nano`
- `openai/gpt-5-mini`
- `openai/gpt-5-nano`
- `github-copilot/gpt-5.4`
- `anthropic/claude-sonnet-4-5`
- `xai/grok-4-fast-non-reasoning`
- `google/gemini-3-flash`
- `zai/glm-4.7`
- `minimax/MiniMax-M3`
- `openrouter/openai/gpt-5-mini` (force OpenRouter)

Note: some models/providers do not support streaming or certain file media types. When that happens, the CLI prints a friendly error (or auto-disables streaming for that model when supported by the provider).
`gpt-5.4-mini` and `gpt-5.4-nano` are treated as real model ids; the same shorthand also works under `github-copilot/...`.

### OpenAI fast mode and thinking

Fast mode is a request option, not a model id:

```bash
summarize "https://example.com" --model openai/gpt-5.5 --fast --thinking medium
summarize "https://example.com" --model openai/gpt-5.4 --service-tier fast --thinking low
```

- `--fast` is shorthand for `--service-tier fast`.
- `--service-tier default|fast|priority|flex` controls OpenAI service tier. `fast` is the summarize/Codex-facing spelling and is sent to OpenAI as `service_tier="priority"`.
- `--thinking none|low|medium|high|xhigh` controls OpenAI reasoning effort. Aliases: `off` → `none`, `min` → `low`, `mid` / `med` → `medium`, `x-high` / `extra-high` → `xhigh`.
- `--service-tier default` clears a configured tier for one run.

Config equivalent:

```json
{
  "model": "openai/gpt-5.5",
  "openai": {
    "serviceTier": "fast",
    "thinking": "medium"
  }
}
```

Compatibility aliases still work, but prefer the explicit flags above:

- `--model gpt-fast` / `--model fast` → `openai/gpt-5.5` + fast tier + medium thinking
- `--model openai/gpt-5.5-fast` → `openai/gpt-5.5` + fast tier

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
- `--model <name>`: use a built-in or config-defined preset (see Configuration)
- `--timeout <duration>`: `30s`, `2m`, `5000ms` (default `2m`)
- `--retries <count>`: LLM retry attempts after timeouts or transient API failures (default `1`)
- `--length short|medium|long|xl|xxl|s|m|l|<chars>`
- `--language, --lang <language>`: output language (`auto` = match source)
- `--max-output-tokens <count>`: hard cap for LLM output tokens
- `--cli [provider]`: use a CLI provider (`--model cli/<provider>`). Supports `claude`, `gemini`, `codex`, `agent`, `openclaw`, `opencode`, `copilot`, `agy`, `pi`. If omitted, uses auto selection with CLI enabled.
- `--stream auto|on|off`: stream LLM output (`auto` = TTY only; disabled in `--json` mode)
- `--plain`: keep raw output (no ANSI/OSC Markdown rendering)
- `--no-color`: disable ANSI colors
- `--theme <name>`: CLI theme (`aurora`, `ember`, `moss`, `mono`)
- `--format md|text`: website/file content format (default `text`)
- `--markdown-mode off|auto|llm|readability`: HTML -> Markdown mode (default `readability`)
- `--preprocess off|auto|always`: controls `uvx markitdown` usage (default `auto`)
  - Install `uvx`: `brew install uv` (or https://astral.sh/uv/)
  - Image-only PDFs can fall back to OpenAI vision OCR when `OPENAI_API_KEY` is set; override the OCR model with `MARKITDOWN_OCR_MODEL` or page render DPI with `MARKITDOWN_OCR_DPI`.
- `--extract`: print extracted content and exit (URLs, YouTube/direct media, local audio/video, and local PDFs; stdin `-` is not supported)
  - Deprecated alias: `--extract-only`
- `--slides`: extract slides for YouTube, direct video URLs, or local video files and render them inline in the summary narrative (auto-renders inline in supported terminals)
- `--no-slides`: disable slide extraction enabled in `~/.summarize/config.json` for one run
- `--slides-ocr`: run OCR on extracted slides (requires `tesseract`)
- `--no-slides-ocr`: disable slide OCR enabled in `~/.summarize/config.json` for one run
- `--slides-dir <dir>`: base output dir for slide images (default `./slides`)
- `--slides-scene-threshold <value>`: scene detection threshold (0.1-1.0)
- `--slides-max <count>`: maximum slides to extract (default `6`)
- `--slides-min-duration <seconds>`: minimum seconds between slides
- `--json`: machine-readable output with diagnostics, prompt, `metrics`, and optional summary
- `--verbose`: debug/diagnostics on stderr
- `--metrics off|on|detailed`: metrics output (default `on`)

### Coding CLIs (Codex, Claude, Gemini, Agent, OpenClaw, OpenCode, Copilot, Antigravity, pi)

Summarize can use common coding CLIs as local model backends:

- `codex` -> `--cli codex` / `--model cli/codex/<model>`
- `claude` -> `--cli claude` / `--model cli/claude/<model>`
- `gemini` -> `--cli gemini` / `--model cli/gemini/<model>`
- `agent` (Cursor Agent CLI) -> `--cli agent` / `--model cli/agent/<model>`
- `openclaw` -> `--cli openclaw` / `--model cli/openclaw/<model>` or `--model openclaw/<model>`
- `opencode` -> `--cli opencode` / `--model cli/opencode/<model>` (`--model cli/opencode` uses the OpenCode runtime default)
- `copilot` (GitHub Copilot CLI) -> `--cli copilot` / `--model cli/copilot/<model>` (`--model cli/copilot` uses the Copilot runtime default)
- `agy` (Antigravity CLI) -> `--cli agy` / `--model cli/agy` (uses agy's active session model; per-call model selection is not supported by agy print mode)
- `pi` (Pi Coding Agent) -> `--cli pi` / `--model cli/pi` or `--model cli/pi/<model>`

Built-in preset:

- `--model codex-fast` runs Codex with GPT-5.5 Fast mode and requires `codex login`.

Requirements:

- Binary installed and on `PATH` (or set `CODEX_PATH`, `CLAUDE_PATH`, `GEMINI_PATH`, `AGENT_PATH`, `OPENCLAW_PATH`, `OPENCODE_PATH`, `COPILOT_PATH`, `AGY_PATH`, `PI_PATH`)
- Provider authenticated (`codex login`, `claude auth`, `gemini` login flow, `agent login` or `CURSOR_API_KEY`, `opencode auth login`, GitHub Copilot CLI authenticated, `agy` login flow or `ANTIGRAVITY_API_KEY`, `pi` uses configured provider API keys)

Quick smoke test:

```bash
printf "Summarize CLI smoke input.\nOne short paragraph. Reply can be brief.\n" >/tmp/summarize-cli-smoke.txt

summarize --cli codex --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli claude --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli gemini --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli agent --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli openclaw --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli opencode --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli copilot --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli agy --plain --timeout 2m /tmp/summarize-cli-smoke.txt
summarize --cli pi --plain --timeout 2m /tmp/summarize-cli-smoke.txt
```

Set explicit CLI allowlist/order:

```json
{
  "cli": {
    "enabled": [
      "codex",
      "claude",
      "gemini",
      "agent",
      "openclaw",
      "opencode",
      "copilot",
      "agy",
      "pi"
    ]
  }
}
```

Configure implicit auto CLI fallback:

```json
{
  "cli": {
    "autoFallback": {
      "enabled": true,
      "onlyWhenNoApiKeys": true,
      "order": ["claude", "gemini", "codex", "agent", "openclaw", "opencode", "copilot"]
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

Default fallback behavior: only when no API keys are configured, order `claude, gemini, codex, agent, openclaw, opencode, copilot`, and remember/prioritize last successful provider (`~/.summarize/cli-state.json`). Antigravity and pi are opt-in unless you add them to `cli.autoFallback.order`.

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

1. yt-dlp + Whisper (if `yt-dlp` is available): downloads audio, then tries Groq (`GROQ_API_KEY`)
   first when configured. If Groq is unavailable or fails, it uses configured local ONNX/`whisper.cpp`,
   then AssemblyAI (`ASSEMBLYAI_API_KEY`), Gemini (`GEMINI_API_KEY` / Google aliases), OpenAI
   (`OPENAI_API_KEY`), FAL (`FAL_KEY`), then Deepgram (`DEEPGRAM_API_KEY`).
2. Android VR direct audio + the same configured transcription chain when `yt-dlp` is unavailable or fails
3. Apify (if `APIFY_API_TOKEN` is set): uses a scraping actor (`faVsWy9VTSNVIhWpR`)

Environment variables for yt-dlp mode:

- `YT_DLP_PATH` - optional path to yt-dlp binary (otherwise `yt-dlp` is resolved via `PATH`)
- `SUMMARIZE_WHISPER_CPP_MODEL_PATH` - optional override for the local `whisper.cpp` model file
- `SUMMARIZE_WHISPER_CPP_BINARY` - optional override for the local binary (default: `whisper-cli`)
- `SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP=1` - disable local whisper.cpp (force remote)
- `GROQ_API_KEY` - Groq Whisper transcription
- `ASSEMBLYAI_API_KEY` - AssemblyAI transcription
- `GEMINI_API_KEY` - Gemini transcription (`GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY` also work)
- `SUMMARIZE_GEMINI_TRANSCRIPTION_MODEL` - optional Gemini model override (default: `gemini-2.5-flash`)
- `OPENAI_API_KEY` - OpenAI Whisper transcription
- `OPENAI_WHISPER_BASE_URL` - optional OpenAI-compatible Whisper endpoint override
- `FAL_KEY` - FAL AI Whisper fallback
- `DEEPGRAM_API_KEY` - Deepgram Nova transcription fallback
- `SUMMARIZE_DEEPGRAM_TRANSCRIPTION_MODEL` - optional Deepgram model override (default: `nova-3`)

Apify costs money but tends to be more reliable when captions exist.

Speaker-labelled transcripts for YouTube, local audio/video, and direct media URLs:

```bash
summarize "https://www.youtube.com/watch?v=..." --extract --diarize
summarize "./interview.mp3" --extract --diarize
summarize "https://cdn.example.com/interview.mp4" --extract --diarize openai
summarize "./interview.mp4" --extract --diarize openai \
  --identify-speakers --speaker-at "0:00=Host" --speaker-at "0:12=Guest"
summarize "https://www.youtube.com/watch?v=..." --extract --diarize elevenlabs
summarize "https://www.youtube.com/watch?v=..." --extract --diarize openai --timestamps
summarize "https://www.youtube.com/watch?v=..." --extract --diarize elevenlabs \
  --identify-speakers --speaker-profile my-podcast \
  --speaker-at "0:12=Host Name" --remember-speakers
```

Bare `--diarize` prefers ElevenLabs Scribe v2 (`ELEVENLABS_API_KEY`) and falls back to OpenAI
`gpt-4o-transcribe-diarize` (`OPENAI_API_KEY`). Speaker changes are emitted as `Speaker <label>: ...`;
combine with `--timestamps` for `[mm:ss] Speaker <label>: ...`. Before upload, local video is reduced
to mono 16 kHz MP3 with native or bundled FFmpeg and the same audio file is reused across provider
fallbacks. Local audio is passed through unless OpenAI's upload limit requires compression. YouTube
diarization downloads audio only. When combined with `--slides`, one yt-dlp invocation downloads
separate audio and slide-quality video streams; diarization uploads the audio while slides reuse the
video. Remote direct media uses its normal audio download path.
YouTube transcript extraction also prints the current public view count and exposes the resolved
video ID and observation timestamp in `extracted.sourceMetrics` in JSON output.
Long OpenAI recordings are split into bounded chunks; timestamps are reassembled and
chunk-local provider labels stay distinct so label resets cannot silently merge different voices.

`--identify-speakers` replaces generic labels with names for YouTube and direct media. Repeat `--speaker-at <timestamp=name>`
for authoritative examples; unresolved labels are inferred with OpenAI GPT-5.5 and only accepted above
the configured confidence threshold. `--remember-speakers` stores the profile, anchors, and a
transcript-hash-guarded mapping in `~/.summarize/config.json` for later runs. See
[YouTube speaker identification](docs/youtube.md#speaker-identification).

### Slide extraction (YouTube + direct video URLs + local video files)

Extract slide screenshots (scene detection via `ffmpeg`) and optional OCR:

Requirements:

- bundled FFmpeg WebAssembly, or native `ffmpeg` for faster extraction and broader codec support
- `yt-dlp` for YouTube video download/stream resolution
- `tesseract` only when using `--slides-ocr`

```bash
summarize "https://www.youtube.com/watch?v=..." --slides
summarize "https://www.youtube.com/watch?v=..." --slides --slides-ocr
summarize "/path/to/video.webm" --slides
```

Outputs are written under `./slides/<sourceId>/` (or `--slides-dir`). OCR results are included in JSON output
(`--json`) and stored in `slides.json` inside the slide directory. When scene detection is too sparse, the
extractor also samples at a fixed interval to improve coverage.
When using `--slides`, supported terminals (kitty/iTerm/Konsole) render inline thumbnails automatically inside the
summary narrative (the model inserts `[slide:N]` markers). Timestamp links are clickable when the terminal supports
OSC-8 (YouTube/Vimeo/Loom/Dropbox). If inline images are unsupported, Summarize prints a note with the on-disk
slide directory. Local video files stay on the slide-aware path, transcribe in place, and avoid fake download labels.

Use `--slides --extract` to print the full timed transcript and insert slide images inline at matching timestamps.

Format the extracted transcript as Markdown (headings + paragraphs) via an LLM:

```bash
summarize "https://www.youtube.com/watch?v=..." --extract --format md --markdown-mode llm
```

### Media transcription (Whisper)

Local audio/video files are transcribed first, then summarized. `--video-mode transcript` forces
direct media URLs (and embedded media) through Whisper first. Auto mode tries Groq first when configured,
then local ONNX/`whisper.cpp`, then cloud fallbacks. Configure local ONNX/`whisper.cpp` for local-only
transcription; otherwise set one of `GROQ_API_KEY`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY` (or Google
aliases), `OPENAI_API_KEY`, `FAL_KEY`, or `DEEPGRAM_API_KEY`.
Use `--diarize [auto|elevenlabs|openai]` for speaker-labelled MP3/MP4 and other supported media;
diarization requires `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`.

### Local ONNX transcription (Parakeet/Canary)

Summarize can use NVIDIA Parakeet/Canary ONNX models via a local CLI you provide. Auto selection
tries Groq first when configured, then ONNX before `whisper.cpp` and the remaining cloud fallbacks.

- Setup helper: `summarize transcriber setup`
- Install `sherpa-onnx` from upstream binaries/build (Homebrew may not have a formula)
- Auto selection: set `SUMMARIZE_ONNX_PARAKEET_CMD` or `SUMMARIZE_ONNX_CANARY_CMD` (no flag needed)
- Select the local transcription stage: `--transcriber parakeet|canary|whisper|auto`
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

Transcription: tries Groq first when configured, then local ONNX/`whisper.cpp`, then AssemblyAI,
Gemini, OpenAI, FAL, or Deepgram when keys are set.

### Translation paths

`--language/--lang` controls the output language of the summary (and other LLM-generated text). Default is `auto`.

When the input is audio/video, the CLI needs a transcript first. The transcript comes from one of these paths:

1. Existing transcript (preferred)
   - YouTube: uses `youtubei` / `captionTracks` when available.
   - Podcasts: uses Podcasting 2.0 RSS `<podcast:transcript>` (JSON/VTT) when the feed publishes it.
2. Whisper transcription (fallback)
   - YouTube: prefers yt-dlp audio download, then Android VR direct audio, plus Whisper transcription when configured; Apify is a last resort.
   - Tries Groq (`GROQ_API_KEY`) first when configured.
   - Then uses configured local ONNX/`whisper.cpp`.
   - Then uses cloud transcription in this order: AssemblyAI (`ASSEMBLYAI_API_KEY`) → Gemini (`GEMINI_API_KEY` / Google aliases) → OpenAI (`OPENAI_API_KEY`) → FAL (`FAL_KEY`) → Deepgram (`DEEPGRAM_API_KEY`).

For direct media URLs, use `--video-mode transcript` to force transcribe -> summarize:

```bash
summarize https://example.com/file.mp4 --video-mode transcript --lang en
```

### Configuration

Single config location:

- `~/.summarize/config.json`

Run `summarize status` to inspect the effective default model, configured presets, and model
providers available from config, environment variables, local endpoints, or installed CLIs.

Supported keys today:

```json
{
  "model": { "id": "openai/gpt-5-mini" },
  "env": { "OPENAI_API_KEY": "sk-..." },
  "output": { "length": "long" },
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
- `models` (define presets selectable via `--model <preset>`; overrides built-ins like `free`)
- `env` (generic env var defaults; process env still wins)
- `apiKeys` (legacy shortcut, mapped to env names; prefer `env` for new configs)
- `output.length` (default: `long`; accepts `short|medium|long|xl|xxl|20k`)
- `cache.media` (media download cache: TTL 7 days, 2048 MB cap by default; `--no-media-cache` disables)
- `media.videoMode: "auto"|"transcript"|"understand"`
- `media.embeddedVideo: "auto"|"off"|"prefer"|"both"` (default `auto`: combine substantial articles with primary embedded YouTube captions)
- `slides.enabled` / `slides.max` / `slides.ocr` / `slides.dir` (defaults for `--slides`)
- `ui.theme: "aurora"|"ember"|"moss"|"mono"`
- `openai.useChatCompletions: true` (force OpenAI-compatible chat completions)
- `openai.serviceTier: "fast"|"priority"|"flex"` (use `"fast"` for the friendly alias)
- `openai.thinking` / `openai.reasoningEffort: "none"|"low"|"medium"|"high"|"xhigh"`
- `openai.textVerbosity: "low"|"medium"|"high"`

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
- `MINIMAX_API_KEY` (for `minimax/...`)
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

MiniMax (OpenAI-compatible):

- Set `MINIMAX_API_KEY=...`
- Optional base URL override: `MINIMAX_BASE_URL=...` (default `https://api.minimax.io/v1`; use the
  China endpoint or a proxy if needed)
- Pick a MiniMax model id (e.g. `MiniMax-M3`, `MiniMax-M2.5`) using MiniMax's exact casing
- Reasoning is requested through MiniMax's separated response fields and omitted from summary text

```bash
export MINIMAX_API_KEY="..."
summarize "https://example.com" --model minimax/MiniMax-M3
```

Optional services:

- `FIRECRAWL_API_KEY` (website extraction fallback)
- `YT_DLP_PATH` (path to yt-dlp binary for audio extraction)
- `GROQ_API_KEY` (Groq Whisper transcription)
- `ASSEMBLYAI_API_KEY` (AssemblyAI transcription)
- `ELEVENLABS_API_KEY` (ElevenLabs Scribe v2 speaker diarization)
- `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY` (Gemini transcription)
- `SUMMARIZE_GEMINI_TRANSCRIPTION_MODEL` (optional Gemini model override; default `gemini-2.5-flash`)
- `OPENAI_API_KEY` / `OPENAI_WHISPER_BASE_URL` (OpenAI Whisper transcription)
- `FAL_KEY` (FAL AI API key for audio transcription via Whisper)
- `DEEPGRAM_API_KEY` (Deepgram API key for Nova transcription)
- `SUMMARIZE_DEEPGRAM_TRANSCRIPTION_MODEL` (optional Deepgram model override; default `nova-3`)
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

- Canonical agent skill: [`.agents/skills/summarize/SKILL.md`](.agents/skills/summarize/SKILL.md). Summarize-specific CLI guidance lives here; downstream integrations should link to this source and keep only integration-specific notes.
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
  - For a non-default port, confirm **Options → Runtime → Daemon → Port** matches the daemon configuration.
  - Logs: `~/.summarize/logs/daemon.err.log`

License: MIT

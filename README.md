# Summarize 👉 Point at any URL or file. Get the gist.

Fast CLI for summarizing *anything you can point at*:

- Web pages (article extraction; Firecrawl fallback if sites block agents)
- YouTube links (best-effort transcripts, optional Apify fallback)
- Remote files (PDFs/images/audio/video via URL — downloaded and forwarded to the model)
- Local files (PDFs/images/audio/video/text — forwarded or inlined; support depends on provider/model)

It streams output by default on TTY and renders Markdown to ANSI (via `markdansi`). At the end it prints a single “Finished in …” line with timing, token usage, and a best-effort cost estimate (when pricing is available).

## Install

Requires Node 22+.

- npx (no install):

```bash
npx -y @steipete/summarize "https://example.com"
```

- npm (global install):

```bash
npm i -g @steipete/summarize
```

- Homebrew (custom tap):

```bash
brew install steipete/tap/summarize
```

Apple Silicon only (arm64).

## Quickstart

```bash
summarize "https://example.com"
```

Input can be a URL or a local file path:

```bash
npx -y @steipete/summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview
npx -y @steipete/summarize "/path/to/image.jpeg" --model google/gemini-3-flash-preview
```

Remote file URLs work the same (best-effort; the file is downloaded and passed to the model):

```bash
npx -y @steipete/summarize "https://example.com/report.pdf" --model google/gemini-3-flash-preview
```

YouTube (supports `youtube.com` and `youtu.be`):

```bash
npx -y @steipete/summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto
```

## What file types work?

This is “best effort” and depends on what your selected model/provider accepts. In practice these usually work well:

- `text/*` and common structured text (`.txt`, `.md`, `.json`, `.yaml`, `.xml`, …)  
  - text-like files are **inlined into the prompt** (instead of attached as a file part) for better provider compatibility
- PDFs: `application/pdf` (provider support varies; Google is the most reliable in this CLI right now)
- Images: `image/jpeg`, `image/png`, `image/webp`, `image/gif`
- Audio/Video: `audio/*`, `video/*` (when supported by the model)

Notes:

- If a provider rejects a media type, the CLI fails fast with a friendly message (no “mystery stack traces”).
- xAI models currently don’t support attaching generic files (like PDFs) via the AI SDK; use a Google/OpenAI/Anthropic model for those.

## Model ids

Use “gateway-style” ids: `<provider>/<model>`.

Examples:

- `openai/gpt-5-mini`
- `anthropic/claude-sonnet-4-5`
- `xai/grok-4-fast-non-reasoning`
- `google/gemini-3-flash-preview`
- `openrouter/openai/gpt-5-mini` (force OpenRouter)

Note: some models/providers don’t support streaming or certain file media types. When that happens, the CLI prints a friendly error (or auto-disables streaming for that model when supported by the provider).

## Output length

`--length` controls *how much output we ask for* (guideline), not a hard truncation.

```bash
npx -y @steipete/summarize "https://example.com" --length long
npx -y @steipete/summarize "https://example.com" --length 20k
```

- Presets: `short|medium|long|xl|xxl`
- Character targets: `1500`, `20k`, `20000`
- Optional hard cap: `--max-output-tokens <count>` (e.g. `2000`, `2k`)
  - Provider/model APIs still enforce their own maximum output limits.
  - If omitted, no max token parameter is sent (provider default).
  - Prefer `--length` unless you need a hard cap (some providers count “reasoning” into the cap).
- Minimums: `--length` numeric values must be ≥ 50 chars; `--max-output-tokens` must be ≥ 16.

## Limits

- Text inputs over 10 MB are rejected before tokenization.
- Text prompts are preflighted against the model’s input limit (LiteLLM catalog), using a GPT tokenizer.

## Common flags

```bash
npx -y @steipete/summarize <input> [flags]
```

- `--model <provider/model>`: which model to use (defaults to `auto`)
- `--model auto`: automatic model selection + fallback (default)
- `--model <name>`: use a config-defined model (see “Configuration”)
- `--timeout <duration>`: `30s`, `2m`, `5000ms` (default `2m`)
- `--retries <count>`: LLM retry attempts on timeout (default `1`)
- `--length short|medium|long|xl|xxl|<chars>`
- `--max-output-tokens <count>`: hard cap for LLM output tokens (optional; only sent when set)
- `--cli [provider]`: use a CLI provider (case-insensitive; equivalent to `--model cli/<provider>`). If omitted, uses auto selection with CLI enabled.
- `--stream auto|on|off`: stream LLM output (`auto` = TTY only; disabled in `--json` mode)
- `--render auto|md-live|md|plain`: Markdown rendering (`auto` = best default for TTY)
- `--format md|text`: website/file content format (default `text`)
- `--preprocess off|auto|always`: controls `uvx markitdown` usage (default `auto`; `always` forces file preprocessing)
  - Install `uvx`: `brew install uv` (or https://astral.sh/uv/)
- `--extract`: print extracted content and exit (no summary) — only for URLs
  - Deprecated alias: `--extract-only`
- `--json`: machine-readable output with diagnostics, prompt, `metrics`, and optional summary
- `--verbose`: debug/diagnostics on stderr
- `--metrics off|on|detailed`: metrics output (default `on`; `detailed` adds a compact 2nd-line breakdown on stderr)

## Auto model ordering

`--model auto` builds candidate attempts from built-in rules (or your `model.rules` overrides).
CLI tools are **not** used in auto mode unless you explicitly enable them via `cli.enabled` in config.
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

Note: when `cli.enabled` is set, it’s also an allowlist for explicit `--cli` / `--model cli/...`.

## Website extraction (Firecrawl + Markdown)

Non-YouTube URLs go through a “fetch → extract” pipeline. When the direct fetch/extraction is blocked or too thin, `--firecrawl auto` can fall back to Firecrawl (if configured).

- `--firecrawl off|auto|always` (default `auto`)
- `--extract --format md|text` (default `text`)
- `--markdown-mode off|auto|llm` (default `auto`; only affects `--format md` for non-YouTube URLs)
  - `auto`: use an LLM converter when configured; may fall back to `uvx markitdown`
  - `llm`: force LLM conversion (requires a configured model key)
  - `off`: disable LLM conversion (still may return Firecrawl Markdown when configured)
- Plain-text mode: use `--format text`.

## YouTube transcripts

`--youtube auto` tries best-effort web transcript endpoints first. When captions aren't available, it falls back to:

1. **Apify** (if `APIFY_API_TOKEN` is set): Uses a scraping actor (`faVsWy9VTSNVIhWpR`)
2. **yt-dlp + Whisper** (if `YT_DLP_PATH` is set): Downloads audio via yt-dlp, transcribes with OpenAI Whisper if `OPENAI_API_KEY` is set, otherwise falls back to FAL (`FAL_KEY`)

Environment variables for yt-dlp mode:
- `YT_DLP_PATH` - path to yt-dlp binary
- `OPENAI_API_KEY` - OpenAI Whisper transcription (preferred)
- `FAL_KEY` - FAL AI Whisper fallback

Apify costs money but tends to be more reliable when captions exist.

## Configuration

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

- `model: { "mode": "auto" }` (automatic model selection + fallback; see `docs/model-auto.md`)
- `model.rules` (customize candidates / ordering)
- `models` (define named models selectable via `--model <name>`)
- `media.videoMode: "auto"|"transcript"|"understand"`

Note: the config is parsed leniently (JSON5), but **comments are not allowed**.
Unknown keys are ignored.

Precedence:

1) `--model`
2) `SUMMARIZE_MODEL`
3) `~/.summarize/config.json`
4) default (`auto`)

## Environment variables

Set the key matching your chosen `--model`:

- `OPENAI_API_KEY` (for `openai/...`)
- `ANTHROPIC_API_KEY` (for `anthropic/...`)
- `XAI_API_KEY` (for `xai/...`)
- `GEMINI_API_KEY` (for `google/...`)  
  - also accepts `GOOGLE_GENERATIVE_AI_API_KEY` and `GOOGLE_API_KEY` as aliases

OpenRouter (OpenAI-compatible):

- Set `OPENROUTER_API_KEY=...`
- Prefer forcing OpenRouter per model id: `--model openrouter/<author>/<slug>` (e.g. `openrouter/meta-llama/llama-3.1-8b-instruct:free`)

Example:

```bash
OPENROUTER_API_KEY=sk-or-... summarize "https://example.com" --model openrouter/meta-llama/llama-3.1-8b-instruct:free
```

If your OpenRouter account enforces an allowed-provider list, make sure at least one provider
is allowed for the selected model. (When routing fails, `summarize` prints the exact providers to allow.)

Legacy: `OPENAI_BASE_URL=https://openrouter.ai/api/v1` (and either `OPENAI_API_KEY` or `OPENROUTER_API_KEY`) also works.

Optional services:

- `FIRECRAWL_API_KEY` (website extraction fallback)
- `YT_DLP_PATH` (path to yt-dlp binary for audio extraction)
- `FAL_KEY` (FAL AI API key for audio transcription via Whisper)
- `APIFY_API_TOKEN` (YouTube transcript fallback)

## Model limits

The CLI uses the LiteLLM model catalog for model limits (like max output tokens):

- Downloaded from: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- Cached at: `~/.summarize/cache/`

## Library usage (optional)

This package also exports a small library:

- `@steipete/summarize/content`
- `@steipete/summarize/prompts`

## Development

```bash
pnpm install
pnpm check
```

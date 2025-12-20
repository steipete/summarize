# Summarize 👉 Point at any URL or file. Get the gist.

Fast CLI for summarizing *anything you can point at*:

- Web pages (article extraction; Firecrawl fallback if sites block agents)
- YouTube links (best-effort transcripts, optional Apify fallback)
- Remote files (PDFs/images/audio/video via URL — downloaded and forwarded to the model)
- Local files (PDFs/images/audio/video/text — forwarded or inlined; support depends on provider/model)

It streams output by default on TTY and renders Markdown to ANSI (via `markdansi`). At the end it prints a single “Finished in …” line with timing, token usage, and a best-effort cost estimate (when pricing is available).

## Install

- npx (no install):

```bash
npx -y @steipete/summarize "https://example.com" --model google/gemini-3-flash-preview
```

- Homebrew (custom tap):

```bash
brew install steipete/tap/summarize
```

## Quickstart

```bash
summarize "https://example.com" --model google/gemini-3-flash-preview
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

- `openai/gpt-5.2`
- `anthropic/claude-opus-4-5`
- `xai/grok-4-fast-non-reasoning`
- `google/gemini-3-flash-preview`

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
- Minimums: `--length` numeric values must be ≥ 50 chars; `--max-output-tokens` must be ≥ 16.

## Limits

- Text inputs over 10 MB are rejected before tokenization.
- Text prompts are preflighted against the model’s input limit (LiteLLM catalog), using a GPT tokenizer.

## Common flags

```bash
npx -y @steipete/summarize <input> [flags]
```

- `--model <provider/model>`: which model to use (defaults to `google/gemini-3-flash-preview`)
- `--timeout <duration>`: `30s`, `2m`, `5000ms` (default `2m`)
- `--length short|medium|long|xl|xxl|<chars>`
- `--max-output-tokens <count>`: hard cap for LLM output tokens (optional)
- `--stream auto|on|off`: stream LLM output (`auto` = TTY only; disabled in `--json` mode)
- `--render auto|md-live|md|plain`: Markdown rendering (`auto` = best default for TTY)
- `--extract-only`: print extracted content and exit (no summary) — only for URLs
- `--json`: machine-readable output with diagnostics, prompt, `metrics`, and optional summary
- `--verbose`: debug/diagnostics on stderr
- `--metrics off|on|detailed`: metrics output (default `on`; `detailed` prints a breakdown to stderr)

## Website extraction (Firecrawl + Markdown)

Non-YouTube URLs go through a “fetch → extract” pipeline. When the direct fetch/extraction is blocked or too thin, `--firecrawl auto` can fall back to Firecrawl (if configured).

- `--firecrawl off|auto|always` (default `auto`)
- `--markdown off|auto|llm` (default `auto`; only affects `--extract-only` for non-YouTube URLs)
- Plain-text mode: use `--firecrawl off --markdown off`.

## YouTube transcripts (Apify fallback)

`--youtube auto` tries best-effort web transcript endpoints first, then falls back to Apify *only if* `APIFY_API_TOKEN` is set.

Apify uses a single actor (`faVsWy9VTSNVIhWpR`). It costs money but tends to be more reliable.

## Configuration

Single config location:

- `~/.summarize/config.json`

Supported keys today:

```json
{
  "model": "openai/gpt-5.2"
}
```

Precedence:

1) `--model`
2) `SUMMARIZE_MODEL`
3) `~/.summarize/config.json`
4) default

## Environment variables

Set the key matching your chosen `--model`:

- `OPENAI_API_KEY` (for `openai/...`)
- `ANTHROPIC_API_KEY` (for `anthropic/...`)
- `XAI_API_KEY` (for `xai/...`)
- `GEMINI_API_KEY` (for `google/...`)  
  - also accepts `GOOGLE_GENERATIVE_AI_API_KEY` and `GOOGLE_API_KEY` as aliases

OpenRouter (OpenAI-compatible):

- Set `OPENROUTER_API_KEY=...` to route `openai/...` models through OpenRouter
- Use OpenRouter models via the `openai/...` prefix, e.g. `--model openai/openai/gpt-oss-20b`
- Optional: `OPENROUTER_PROVIDERS=...` to specify provider fallback order (e.g. `groq,google-vertex`)

Example:

```bash
OPENROUTER_API_KEY=sk-or-... summarize "https://example.com" --model openai/openai/gpt-oss-20b
```

With provider ordering (falls back through providers in order):

```bash
OPENROUTER_API_KEY=sk-or-... OPENROUTER_PROVIDERS="groq,google-vertex" summarize "https://example.com"
```

Legacy: `OPENAI_BASE_URL=https://openrouter.ai/api/v1` with `OPENAI_API_KEY` also works.

Optional services:

- `FIRECRAWL_API_KEY` (website extraction fallback)
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

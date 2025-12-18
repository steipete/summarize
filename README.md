# @steipete/summarize

Fast CLI for summarizing *anything you can point at*:

- Web pages
- YouTube links (best-effort transcripts, optional Apify fallback)
- Local files (PDFs, images, etc. — forwarded to the model; support depends on provider/model)

It streams output by default on TTY and renders Markdown to ANSI (via `markdansi`). At the end it prints a single “Finished in …” line with timing, token usage, and estimated cost (when available).

## Quickstart

```bash
npx -y @steipete/summarize "https://example.com" --model openai/gpt-5.2
```

Input can be a URL or a local file path:

```bash
npx -y @steipete/summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview
npx -y @steipete/summarize "/path/to/image.jpeg" --model google/gemini-3-flash-preview
```

YouTube (supports `youtube.com` and `youtu.be`):

```bash
npx -y @steipete/summarize "https://youtu.be/dQw4w9WgXcQ" --youtube auto
```

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

Internally we pass a `maxOutputTokens` limit to the provider request. There is **no global cap**; when possible we clamp only to the provider/model’s own max output tokens (from the LiteLLM catalog) to avoid request failures.

## Common flags

```bash
npx -y @steipete/summarize <input> [flags]
```

- `--model <provider/model>`: which model to use (defaults to `xai/grok-4-fast-non-reasoning`)
- `--timeout <duration>`: `30s`, `2m`, `5000ms` (default `2m`)
- `--length short|medium|long|xl|xxl|<chars>`
- `--stream auto|on|off`: stream LLM output (`auto` = TTY only; disabled in `--json` mode)
- `--render auto|md-live|md|plain`: Markdown rendering (`auto` = best default for TTY)
- `--extract-only`: print extracted content (no LLM call) — only for URLs
- `--json`: machine-readable output with diagnostics, prompt, and optional summary
- `--verbose`: debug/diagnostics on stderr
- `--cost`: detailed token + cost breakdown on stderr

## Website extraction (Firecrawl + Markdown)

Non-YouTube URLs go through a “fetch → extract” pipeline. When the direct fetch/extraction is blocked or too thin, `--firecrawl auto` can fall back to Firecrawl (if configured).

- `--firecrawl off|auto|always` (default `auto`)
- `--markdown off|auto|llm` (default `auto`; only affects `--extract-only` for non-YouTube URLs)
- `--raw`: disables Firecrawl + LLM Markdown conversion (shorthand for `--firecrawl off --markdown off`)

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
- `GOOGLE_GENERATIVE_AI_API_KEY` (for `google/...`)  
  - also accepts `GEMINI_API_KEY` and `GOOGLE_API_KEY` as aliases

Optional services:

- `FIRECRAWL_API_KEY` (website extraction fallback)
- `APIFY_API_TOKEN` (YouTube transcript fallback)

## Pricing + cost reporting

`--cost` and the final “Finished in …” line use the LiteLLM model catalog for pricing and model limits:

- Downloaded from: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- Cached at: `~/.summarize/cache/`

USD cost is best-effort; token counts are the source of truth.

## Library usage (optional)

This package also exports a small library:

- `@steipete/summarize/content`
- `@steipete/summarize/prompts`

## Development

```bash
pnpm install
pnpm check
```

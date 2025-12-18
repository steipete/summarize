# Website mode

Use this for non-YouTube URLs.

## What it does

- Fetches the page HTML.
- Extracts “article-ish” content and normalizes it into clean text.
- If extraction looks blocked or too thin, it can retry via Firecrawl (Markdown).
- In `--extract-only` mode, the CLI prefers Firecrawl Markdown by default when `FIRECRAWL_API_KEY` is configured.
- In `--extract-only` mode, `--markdown auto` can also convert HTML → Markdown via an LLM (Gemini/OpenAI) when configured.

## Flags

- `--firecrawl off|auto|always`
- `--markdown off|auto|llm` (default: `auto`; only affects `--extract-only` for non-YouTube URLs)
- `--raw` (shorthand for `--firecrawl off --markdown off`)
- `--timeout 30s|30|2m|5000ms` (default: `2m`)
- `--extract-only` (print extracted content, no LLM call)
- `--json` (emit a single JSON object)
- `--verbose` (progress + which extractor was used)

## API keys

- Optional: `FIRECRAWL_API_KEY` (for the Firecrawl fallback / preferred Markdown output)
- Optional: `GOOGLE_GENERATIVE_AI_API_KEY` (LLM HTML→Markdown conversion; used by `--markdown auto|llm`)
- Optional: `AI_GATEWAY_API_KEY` (Vercel AI Gateway; enables `google/gemini-3-flash` for `--markdown auto|llm`)

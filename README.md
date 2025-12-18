# summarize 🗜️ — Link → clean text → summary.

Personal URL summarization CLI + a small reusable library.

One npm package: `@steipete/summarize` (CLI + library exports).

Docs (by mode):

- `docs/website.md`
- `docs/youtube.md`
- `docs/firecrawl.md`
- `docs/llm.md`
- `docs/extract-only.md`

## Features

- **URL → clean text**: fetches HTML, extracts the main article-ish content, normalizes it for prompts.
- **YouTube transcripts** (when the URL is a YouTube link):
  - `youtubei` transcript endpoint (best-effort)
  - `captionTracks` (best-effort)
  - Apify transcript actor (optional fallback, requires `APIFY_API_TOKEN`)
  - If transcripts are blocked, we still extract `ytInitialPlayerResponse.videoDetails.shortDescription` so YouTube links summarize meaningfully.
- **Firecrawl fallback for blocked sites**: if direct HTML fetching is blocked or yields too little content, we retry via Firecrawl to get Markdown (requires `FIRECRAWL_API_KEY`).
- **LLM HTML→Markdown (optional)**: in `--extract-only` website mode, `--markdown auto|llm` can convert HTML → clean Markdown (Gemini/OpenAI, depending on which keys are configured).
- **Prompt-only mode**: print the generated prompt and use any model/provider you want.
- **LLM mode**: uses Vercel AI Gateway (Grok) when `AI_GATEWAY_API_KEY` is set, otherwise OpenAI when `OPENAI_API_KEY` is set.
- **Structured output**: `--json` emits a single JSON object with extraction diagnostics + the prompt + (optional) summary.
- **Extract-only mode**: `--extract-only` prints the extracted content (no LLM call).

## CLI usage

Preferred install (global):

```bash
npm install -g @steipete/summarize
```

Run:

```bash
summarize "https://example.com"
summarize "https://example.com" --prompt
```

One-off (no install):

```bash
npx -y @steipete/summarize "https://example.com"
```

Local dev:

```bash
pnpm install
pnpm build
```

Run without building (direct TS via `tsx`):

```bash
pnpm summarize -- "https://example.com" --prompt
```

Summarize a URL:

```bash
summarize "https://example.com"
```

Print the prompt only:

```bash
summarize "https://example.com" --prompt
```

Change model, length, YouTube mode, and timeout:

```bash
summarize "https://example.com" --length 20k --timeout 30s --model gpt-5.2
summarize "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s" --youtube auto --length 8k
```

Structured JSON output:

```bash
summarize "https://example.com" --json
```

### Flags

- `--youtube auto|web|apify`
  - `auto` (default): try YouTube web endpoints first (`youtubei` / `captionTracks`), then fall back to Apify
  - `web`: only try YouTube web endpoints (no Apify)
  - `apify`: only try Apify (no web endpoints)
- `--firecrawl off|auto|always`
  - `off`: never use Firecrawl
  - `auto` (default): use Firecrawl only as a fallback when HTML fetch/extraction looks blocked or too thin
  - `always`: try Firecrawl first (still falls back to HTML when Firecrawl is unavailable/empty)
- `--markdown off|auto|llm`
  - `off`: never attempt LLM HTML→Markdown conversion
  - `auto` (default): in `--extract-only` website mode, prefer Firecrawl Markdown when configured; otherwise convert via LLM when configured
  - `llm`: force LLM HTML→Markdown conversion (errors when no LLM keys are configured)
- `--raw`
  - Raw website extraction (disables Firecrawl + LLM Markdown conversion). Shorthand for `--firecrawl off --markdown off`.
- `--length short|medium|long|xl|xxl|<chars>`
  - Presets influence formatting; `<chars>` (e.g. `20k`, `1500`) adds a soft “target length” instruction (no hard truncation).
- `--timeout <duration>`: `30` (seconds), `30s`, `2m`, `5000ms` (default: `2m`)
- `--provider auto|gateway|openai`
  - `auto` (default): uses AI Gateway for `xai/...`/`google/...` model ids when `AI_GATEWAY_API_KEY` is set; otherwise uses OpenAI when `OPENAI_API_KEY` is set
  - `gateway`: require `AI_GATEWAY_API_KEY`
  - `openai`: require `OPENAI_API_KEY`
- `--model <model>`
  - Default: `xai/grok-4.1-fast-non-reasoning` when `AI_GATEWAY_API_KEY` is set, otherwise `gpt-5.2`.
  - Override via `SUMMARIZE_MODEL` or `--model`.
- `--prompt`: print prompt and exit (never calls an LLM)
- `--extract-only`: print extracted content and exit (never calls an LLM)
- `--json`: emit a single JSON object instead of plain text
- `--verbose`: print detailed progress + extraction diagnostics to stderr

## Required services & API keys

### LLM (optional, required for “actual summarization”)

If neither `AI_GATEWAY_API_KEY` nor `OPENAI_API_KEY` is set, the CLI prints the prompt instead of calling an LLM.

- `AI_GATEWAY_API_KEY` (optional; Vercel AI Gateway; enables `xai/grok-4.1-fast-non-reasoning`)
- `OPENAI_API_KEY` (optional; used for `--provider openai` and as a fallback when the gateway isn’t configured)
- `SUMMARIZE_MODEL` (optional; overrides default model selection)

### Apify (optional YouTube fallback)

Used only as a fallback when YouTube transcript endpoints fail and only if the token is present.

- `APIFY_API_TOKEN` (optional)

### Firecrawl (optional website fallback)

Used only as a fallback for non-YouTube URLs when direct HTML fetching/extraction looks blocked or too thin.

- `FIRECRAWL_API_KEY` (optional)

### LLM website Markdown (optional)

Used only for `--extract-only` website URLs when `--markdown auto|llm` is enabled.

- `AI_GATEWAY_API_KEY` (optional; uses Vercel AI Gateway; default model `google/gemini-3-flash`)
- `GOOGLE_GENERATIVE_AI_API_KEY` (optional; calls Gemini directly; default model `gemini-3-flash`)
- `OPENAI_API_KEY` (optional fallback for Markdown conversion when neither Gemini key is present; default model `gpt-5.2`)

## Library API (for other Node programs)

`@steipete/summarize` exports entry points:

- `@steipete/summarize/content`
  - `createLinkPreviewClient({ fetch?, scrapeWithFirecrawl?, apifyApiToken?, convertHtmlToMarkdown? })`
  - `client.fetchLinkContent(url, { timeoutMs?, youtubeTranscript?, firecrawl?, format? })`
- `@steipete/summarize/prompts`
  - `buildLinkSummaryPrompt(...)` (`summaryLength` supports presets or `{ maxCharacters }`)
  - `SUMMARY_LENGTH_TO_TOKENS`

## Dev

```bash
pnpm check     # biome + build + tests
pnpm lint:fix  # apply Biome fixes
```

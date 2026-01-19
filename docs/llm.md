---
summary: "LLM usage, env vars, flags, and prompt rules."
read_when:
  - "When changing model selection or prompt formatting."
---

# LLM / summarization mode

By default `summarize` will call an LLM using **direct provider API keys**. When CLI tools are
installed, auto mode can use local CLI models when `cli.enabled` is set (see `docs/cli.md`).

## Defaults

- Default model: `auto`
- Override with `SUMMARIZE_MODEL`, config file (`model`), or `--model`.

## Env

- `.env` (optional): when running the CLI, `summarize` also reads `.env` in the current working directory and merges it into the environment (real env vars win).
- `XAI_API_KEY` (required for `xai/...` models)
- `XAI_BASE_URL` (optional; override xAI API endpoint)
- `OPENAI_API_KEY` (required for `openai/...` models)
- `OPENAI_BASE_URL` (optional; OpenAI-compatible API endpoint, e.g. OpenRouter)
- `OPENAI_USE_CHAT_COMPLETIONS` (optional; force OpenAI chat completions)
- `OPENROUTER_API_KEY` (optional; required for `openrouter/...` models; also used when `OPENAI_BASE_URL` points to OpenRouter)
- `Z_AI_API_KEY` (required for `zai/...` models; supports `ZAI_API_KEY` alias)
- `Z_AI_BASE_URL` (optional; override default Z.AI base URL)
- `GEMINI_API_KEY` (required for `google/...` models; also accepts `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`)
- `GOOGLE_BASE_URL` / `GEMINI_BASE_URL` (optional; override Google API endpoint)
- `ANTHROPIC_API_KEY` (required for `anthropic/...` models)
- `ANTHROPIC_BASE_URL` (optional; override Anthropic API endpoint)
- `SUMMARIZE_MODEL` (optional; overrides default model selection)
- `CLAUDE_PATH` / `CODEX_PATH` / `GEMINI_PATH` (optional; override CLI binary paths)

## Flags

- `--model <model>`
  - Examples:
    - `cli/codex/gpt-5.2`
    - `cli/claude/sonnet`
    - `cli/gemini/gemini-3-flash-preview`
    - `google/gemini-3-flash-preview`
    - `openai/gpt-5-mini`
    - `zai/glm-4.7`
    - `xai/grok-4-fast-non-reasoning`
    - `google/gemini-2.0-flash`
    - `anthropic/claude-sonnet-4-5`
    - `openrouter/meta-llama/llama-3.3-70b-instruct:free` (force OpenRouter)
- `--cli [provider]`
  - Examples: `--cli claude`, `--cli Gemini`, `--cli codex` (equivalent to `--model cli/<provider>`); `--cli` alone uses auto selection with CLI enabled.
- `--model auto`
  - See `docs/model-auto.md`
- `--model <preset>`
  - Uses a config-defined preset (see `docs/config.md` → “Presets”).
- `--prompt <text>` / `--prompt-file <path>`
  - Overrides the built-in summary instructions (prompt becomes the instruction prefix).
  - Prompts are wrapped in `<instructions>`, `<context>`, `<content>` tags.
  - When `--length` is numeric, we add `Output is X characters.` When `--language` is explicitly set, we add `Output should be <language>.`
- `--no-cache`
  - Bypass cache reads and writes (extracted content, transcripts, summaries).
- `--cache-stats`
  - Print cache stats and exit.
- `--clear-cache`
  - Delete the cache database and exit. Must be used alone.
- `--video-mode auto|transcript|understand`
  - Only relevant for video inputs / video-only pages.
- `--length short|medium|long|xl|xxl|<chars>`
  - This is *soft guidance* to the model (no hard truncation).
  - Minimum numeric value: 50 chars.
  - Default: `long`.
  - Output format is Markdown; use short paragraphs and only add bullets when they improve scanability.
- `--force-summary`
  - Always run the LLM even when extracted content is shorter than the requested length.
- `--max-output-tokens <count>`
  - Hard cap for output tokens (optional).
  - If omitted, no max token parameter is sent (provider default).
  - Minimum numeric value: 16.
  - Recommendation: prefer `--length` unless you need a hard cap (some providers count “reasoning” into the cap).
- `--retries <count>`
  - LLM retry attempts on timeout (default: 1).
- `--json` (includes prompt + summary in one JSON object)

## Prompt rules

- Video and podcast summaries ignore sponsor/ads/promotional segments; do not include them in the summary.

## Z.AI

Use `--model zai/<model>` (e.g. `zai/glm-4.7`). Defaults to Z.AI’s base URL and uses chat completions.

## Input limits

- Text prompts are checked against the model’s max input tokens (LiteLLM catalog) using a GPT tokenizer.
- Text files over 10 MB are rejected before tokenization.

## PDF attachments

- For PDF inputs, `--preprocess auto` will send the PDF directly to Anthropic/OpenAI/Gemini when a fixed model supports documents; otherwise we fall back to markitdown.
- `--preprocess always` forces markitdown (no direct attachments).
- Streaming is disabled for document attachments.

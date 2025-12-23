# LLM / summarization mode

By default `summarize` will call an LLM using **direct provider API keys**. When CLI tools are
installed, auto mode can use local CLI models when `cli.enabled` is set (see `docs/cli.md`).

## Defaults

- Default model: `auto`
- Override with `SUMMARIZE_MODEL`, config file (`model`), or `--model`.

## Env

- `.env` (optional): when running the CLI, `summarize` also reads `.env` in the current working directory and merges it into the environment (real env vars win).
- `XAI_API_KEY` (required for `xai/...` models)
- `OPENAI_API_KEY` (required for `openai/...` models)
- `OPENAI_BASE_URL` (optional; OpenAI-compatible API endpoint, e.g. OpenRouter)
- `OPENROUTER_API_KEY` (optional; required for `openrouter/...` models; also used when `OPENAI_BASE_URL` points to OpenRouter)
- `GEMINI_API_KEY` (required for `google/...` models; also accepts `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`)
- `ANTHROPIC_API_KEY` (required for `anthropic/...` models)
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
    - `xai/grok-4-fast-non-reasoning`
    - `google/gemini-2.0-flash`
    - `anthropic/claude-sonnet-4-5`
    - `openrouter/meta-llama/llama-3.3-70b-instruct:free` (force OpenRouter)
- `--cli [provider]`
  - Examples: `--cli claude`, `--cli Gemini`, `--cli codex` (equivalent to `--model cli/<provider>`); `--cli` alone uses auto selection with CLI enabled.
- `--model auto`
  - See `docs/model-auto.md`
- `--model <bag>`
  - Uses a config-defined bag (see `docs/config.md` → “Model bags”).
- `--video-mode auto|transcript|understand`
  - Only relevant for video inputs / video-only pages.
- `--length short|medium|long|xl|xxl|<chars>`
  - This is *soft guidance* to the model (no hard truncation).
  - Minimum numeric value: 50 chars.
  - Default: `long`.
- `--max-output-tokens <count>`
  - Hard cap for output tokens (optional).
  - If omitted, no max token parameter is sent (provider default).
  - Minimum numeric value: 16.
  - Recommendation: prefer `--length` unless you need a hard cap (some providers count “reasoning” into the cap).
- `--retries <count>`
  - LLM retry attempts on timeout (default: 1).
- `--json` (includes prompt + summary in one JSON object)

## Input limits

- Text prompts are checked against the model’s max input tokens (LiteLLM catalog) using a GPT tokenizer.
- Text files over 10 MB are rejected before tokenization.

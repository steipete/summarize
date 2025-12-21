# LLM / summarization mode

By default `summarize` will call an LLM using **direct provider API keys**.

## Defaults

- Default model: `google/gemini-3-flash-preview`
- Override with `SUMMARIZE_MODEL`, config file (`model`), or `--model`.

## Env

- `XAI_API_KEY` (required for `xai/...` models)
- `OPENAI_API_KEY` (required for `openai/...` models)
- `OPENAI_BASE_URL` (optional; OpenAI-compatible API endpoint, e.g. OpenRouter)
- `OPENROUTER_API_KEY` (optional; used when `OPENAI_BASE_URL` points to OpenRouter)
- `GEMINI_API_KEY` (required for `google/...` models; also accepts `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`)
- `ANTHROPIC_API_KEY` (required for `anthropic/...` models)
- `SUMMARIZE_MODEL` (optional; overrides default model selection)

## Flags

- `--model <model>`
  - Examples:
    - `google/gemini-3-flash-preview`
    - `openai/gpt-5.2`
    - `xai/grok-4-fast-non-reasoning`
    - `google/gemini-2.0-flash`
    - `anthropic/claude-sonnet-4-5`
- `--model auto`
  - See `docs/model-auto.md` (design)
- `--length short|medium|long|xl|xxl|<chars>`
  - This is *soft guidance* to the model (no hard truncation).
  - Minimum numeric value: 50 chars.
- `--max-output-tokens <count>`
  - Hard cap for output tokens (optional).
  - Minimum numeric value: 16.
- `--retries <count>`
  - LLM retry attempts on timeout (default: 1).
- `--json` (includes prompt + summary in one JSON object)

## Input limits

- Text prompts are checked against the model’s max input tokens (LiteLLM catalog) using a GPT tokenizer.
- Text files over 10 MB are rejected before tokenization.

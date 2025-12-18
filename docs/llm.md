# LLM / summarization mode

By default `summarize` will try to call an LLM. If no LLM keys are configured, it prints the prompt instead.

## Defaults

- Default model selection:
  - If `AI_GATEWAY_API_KEY` is set: `xai/grok-4.1-fast-non-reasoning`
  - Otherwise: `gpt-5.2`
- Override with `SUMMARIZE_MODEL` or `--model`.

## Env

- `AI_GATEWAY_API_KEY` (optional; enables Vercel AI Gateway model ids like `xai/...` and `google/...`)
- `OPENAI_API_KEY` (optional; used by `--provider openai` and as a fallback for Markdown conversion)
- `SUMMARIZE_MODEL` (optional; overrides default model selection)

## Flags

- `--provider auto|gateway|openai`
  - `auto` (default): uses gateway for `xai/...`/`google/...` model ids when configured; otherwise uses OpenAI when configured.
  - `gateway`: require `AI_GATEWAY_API_KEY`
  - `openai`: require `OPENAI_API_KEY`
- `--model <model>`
  - Examples:
    - `xai/grok-4.1-fast-non-reasoning` (AI Gateway)
    - `gpt-5.2` (OpenAI direct)
    - `openai/gpt-5.2` (works with `--provider openai`; prefix is stripped)
- `--length short|medium|long|xl|xxl|<chars>`
  - This is *soft guidance* to the model (no hard truncation).
- `--prompt` (print prompt and exit)
- `--json` (includes prompt + summary in one JSON object)


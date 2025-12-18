# OpenAI mode

This is the OpenAI-specific provider for summarization.

For the full model/provider matrix, see `docs/llm.md`.

## Env

- `OPENAI_API_KEY` (required for `--provider openai`)

## Flags

- `--provider openai`
- `--model <model>` (default is `gpt-5.2` when no gateway is configured)
  - `openai/<model>` is accepted and the prefix is stripped.
- `--length short|medium|long|xl|xxl|<chars>`
  - This is *soft guidance* to the model (no hard truncation).
- `--prompt` (print prompt and exit)
- `--json` (includes prompt + summary in one JSON object)

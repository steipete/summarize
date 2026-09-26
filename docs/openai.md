---
title: "OpenAI"
kicker: "models"
summary: "OpenAI model usage and flags."
read_when:
  - "When changing OpenAI integration."
---

# OpenAI models

Use OpenAI directly by choosing an `openai/...` model id.

For the full model/provider matrix, see `docs/llm.md`.

## GPT-6

Use the documented model ids: `openai/gpt-6-astra`, `openai/gpt-6-sol`, or `openai/gpt-6-luna`.
Summarize uses the Responses API by default for direct OpenAI text and image requests, including streaming, and for PDF inputs. `OPENAI_USE_CHAT_COMPLETIONS=1` still selects Chat Completions for text and images.
Reasoning requests omit `temperature`, which GPT-6 rejects. Sol and Luna preserve temperature when explicitly using `--thinking none`; Astra requires reasoning.

```sh
summarize https://summarize.sh/ --model openai/gpt-6-astra --thinking medium --fast
summarize https://summarize.sh/ --model openai/gpt-6-sol --thinking medium
summarize https://summarize.sh/ --model openai/gpt-6-luna --thinking low
```

These explicit model ids do not change the default model or existing presets.
The model picker and built-in pricing catalog include all three models. Standard input/output
prices per million tokens are $10/$50 for Astra, $2/$10 for Sol, and $0.10/$0.50 for Luna.
Cost estimates use these standard rates; they do not include cache discounts, cache writes,
fast/flex service tiers, or long-context premiums. See [OpenAI pricing](https://developers.openai.com/api/docs/pricing).
An unsupported `--thinking none` request for Astra fails locally before sending an API request.
See OpenAI's [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model) and model pages for [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), and [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Fast mode

Fast mode is a service tier, not a model id. Prefer flags:

```sh
summarize URL --model openai/gpt-5.5 --fast --thinking medium
summarize URL --model openai/gpt-5.4 --service-tier fast --thinking low
```

Compatibility aliases:

- `--model gpt-fast` / `--model fast`: `openai/gpt-5.5` with fast service tier and medium thinking.
- `--model openai/gpt-5.5-fast` or `--model openai/gpt-5.4-mini-fast`: strip the `-fast` suffix for the API model id and use fast service tier.
- `--model codex-fast`: explicit Codex CLI fast preset.

## Env

- `OPENAI_API_KEY` (required for `openai/...` models)
- `OPENAI_USE_CHAT_COMPLETIONS` (optional; force chat completions)

## Flags

- `--model openai/<model>`
- `--fast`
- `--service-tier default|fast|priority|flex`
- `--thinking none|low|medium|high|xhigh`
- `--length short|medium|long|xl|xxl|<chars>`
  - This is _soft guidance_ to the model (no hard truncation).
- `--max-output-tokens <count>`
  - Hard cap for output tokens (optional).
- `--json` (includes prompt + summary in one JSON object)

## Config

```json
{
  "openai": {
    "serviceTier": "fast",
    "thinking": "medium"
  }
}
```

`openai.reasoningEffort` is the long-form alias for `openai.thinking`. Model presets can also set `serviceTier`, `thinking` / `reasoningEffort`, and `textVerbosity`.

Use `"serviceTier": "fast"` in summarize config and model presets. OpenAI API requests map that to `service_tier="priority"`; `"flex"` and explicit `"priority"` pass through as-is. Use `--service-tier default` to clear a configured tier for one run.

## PDF inputs

- When a PDF is provided and `--preprocess auto` is used, summarize sends the PDF as a file input via the OpenAI Responses API.
- Document streaming is disabled for file inputs; non-streaming calls are used instead.

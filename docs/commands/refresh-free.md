---
title: summarize refresh-free
permalink: /docs/commands/refresh-free.html
kicker: command
summary: "Scan OpenRouter :free models and write working candidates to config."
---

# `summarize refresh-free`

```text
summarize refresh-free [--runs 2] [--smart 3] [--min-params 27b]
                       [--max-age-days 180] [--set-default] [--verbose]
```

Probes [OpenRouter](https://openrouter.ai)'s catalog for `:free` models, runs them on a small benchmark, and writes the working ones to `models.free` in `~/.summarize/config.json`. Useful when you want to use `--model free` without picking a specific OpenRouter slug.

Needs `OPENROUTER_API_KEY` in the environment.

## What it does

1. Pulls the OpenRouter model catalog.
2. Filters to models tagged `:free` that meet `--min-params` and `--max-age-days`.
3. Runs each candidate `--runs` times against a sanity prompt; ranks by `--smart` heuristics (latency, completion length, refusal rate).
4. Writes the survivors to `models.free` in `~/.summarize/config.json`.
5. With `--set-default`, also sets top-level `model` to `free`.

After the run, `summarize "https://example.com" --model free` rotates through the saved list until one succeeds.

## Flags

`--runs <n>`
: How many times to probe each candidate. Default `2`.

`--smart <n>`
: How many top candidates to keep. Default `3`.

`--min-params <size>`
: Minimum parameter count. Accepts `7b`, `27b`, `70b`, etc. Default `27b`.

`--max-age-days <n>`
: Reject models older than N days based on OpenRouter's metadata. Default `180`.

`--set-default`
: Also set `model: "free"` at the top level of `~/.summarize/config.json`.

`--verbose`
: Per-candidate progress, timings, and rejection reasons on stderr.

## Examples

```bash
# Quick refresh; keep the best 3 free models ≥27B, ≤180d old.
summarize refresh-free

# Looser filter — accept smaller / older models.
summarize refresh-free --min-params 7b --max-age-days 365

# Refresh and also set the default model.
summarize refresh-free --set-default

# Verbose ranking output for debugging.
summarize refresh-free --runs 3 --smart 5 --verbose
```

## Output

`~/.summarize/config.json` is updated in place. The relevant section ends up looking like:

```json
{
  "models": {
    "free": ["openai/gpt-oss-120b:free", "z-ai/glm-4.6:free", "deepseek/deepseek-r1:free"]
  }
}
```

A short summary of survivors and rejected candidates is printed on stdout.

## See also

- [LLM overview](../llm.md) — `--model` syntax, including `free`.
- [Auto selection](../model-auto.md) — how `auto` picks across providers.
- [Config](../config.md) — full schema for `~/.summarize/config.json`.

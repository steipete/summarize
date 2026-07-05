---
title: summarize transcriber
permalink: /docs/commands/transcriber.html
kicker: command
summary: "Set up local ONNX transcription (Parakeet, Canary)."
---

# `summarize transcriber`

```text
summarize transcriber setup [--model parakeet|canary] [--theme <name>]
```

Configures local ONNX transcription. The command **prints the env vars** you need to export — it doesn't write to your shell config. Once those vars are exported, `--transcriber auto` (or `SUMMARIZE_TRANSCRIBER=auto`) uses ONNX after Groq and before `whisper.cpp` and the remaining cloud fallbacks.

## How auto picks a transcriber

When `--transcriber auto` is set (default), summarize tries providers in this order:

1. **Groq** — fastest cloud option. Needs `GROQ_API_KEY`.
2. **Local ONNX** (Parakeet or Canary), then `whisper.cpp` — fully offline. ONNX needs the env vars from this command.
3. **AssemblyAI / Gemini / OpenAI / FAL / Deepgram** — cloud fallbacks, in that order, gated by their respective API keys.

`OPENAI_WHISPER_BASE_URL` changes the endpoint used by the OpenAI transcription stage; it is not a separate provider in the order above.

## Subcommand

### `summarize transcriber setup`

`--model <name>`
: `parakeet` (default) or `canary`. Picks which ONNX model the printed snippet targets.

`--theme <name>`
: CLI theme override.

The output is a labelled, copy-pasteable block of `export` lines for your shell. Re-run with the other model to switch.

## Environment

Set by the printed snippet:

`SUMMARIZE_ONNX_PARAKEET_CMD`
: Command to run Parakeet ONNX transcription. Use `{input}` as the audio-file placeholder.

`SUMMARIZE_ONNX_CANARY_CMD`
: Command to run Canary ONNX transcription. Use `{input}` as the audio-file placeholder.

`SUMMARIZE_TRANSCRIBER`
: Optional. Select the local stage with `auto`, `whisper`, `parakeet`, or `canary` without passing `--transcriber` every time.

## Examples

```bash
# Default: Parakeet.
summarize transcriber setup

# Set up Canary instead.
summarize transcriber setup --model canary

# After exporting the printed vars:
summarize "https://podcasts.apple.com/.../episode-..." --transcriber parakeet
```

## See also

- [ONNX transcription](../nvidia-onnx-transcription.md) — how to actually install the model + runtime.
- [Transcript provider flow](../transcript-provider-flow.md) — full selection waterfall.

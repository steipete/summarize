---
title: "Ollama (local)"
kicker: "providers"
summary: "Use a local Ollama instance for fully offline summarization."
read_when:
  - "When configuring local LLMs via Ollama."
---

# Ollama

[Ollama](https://ollama.com) exposes an OpenAI-compatible chat completions API at
`http://localhost:11434/v1` by default. `summarize` talks to it directly — no API key, no cloud
round-trip, no data leaves the machine.

## Quick start

```bash
# 1. Pull a model that fits your VRAM
ollama pull qwen3:14b

# 2. Run summarize against it
summarize "https://example.com" --model ollama/qwen3:14b
```

That's it. No env vars are required for the default `http://localhost:11434/v1` endpoint.

## Configuration

### CLI

```bash
summarize <url> --model ollama/<model>
```

The `<model>` part must match the tag in `ollama list` exactly, including the variant suffix:

- `ollama/qwen3:14b`
- `ollama/llama3.1:8b`
- `ollama/gemma3:12b-it-q8_0`

### Config file (`~/.summarize/config.json`)

```json
{
  "model": "ollama/qwen3:14b",
  "ollama": { "baseUrl": "http://localhost:11434/v1" }
}
```

`ollama.baseUrl` is only needed when pointing at a remote Ollama instance or a non-default port.

### Environment

| Var               | Purpose                                                       | Default                     |
| ----------------- | ------------------------------------------------------------- | --------------------------- |
| `OLLAMA_BASE_URL` | Override the Ollama OpenAI-compatible base URL (incl. `/v1`). | `http://localhost:11434/v1` |

`OLLAMA_BASE_URL` also gates auto-discovery in the Chrome/Firefox extension model picker — set it
(or `ollama.baseUrl` in config) and your installed Ollama models appear in the dropdown
automatically.

### Remote Ollama

If Ollama is running on another machine on your LAN (or behind Tailscale):

```bash
export OLLAMA_BASE_URL=http://gpu-rig.lan:11434/v1
summarize "https://example.com" --model ollama/qwen3:14b
```

### Auth-fronted Ollama

If you've put an auth proxy in front of Ollama, set `OPENAI_API_KEY` — `summarize` will forward it
as the `Authorization: Bearer …` header. Bare Ollama ignores the header (any value works), so a
dummy is also fine.

## Model recommendations

For summarization quality on a 16 GB consumer GPU at Q4_K_M quantization (~10 GB on disk):

- **`qwen3:14b`** — strong instruction-following, ~128K context, current generation as of 2026.
  Excellent for long articles, podcasts, and YouTube transcripts.
- **`gemma3:12b`** — newer Gemma generation, instruction-tuned, lighter VRAM footprint, leaves
  headroom for longer contexts.
- **`mistral-small:24b`** — biggest that comfortably fits in 16 GB at Q4; better quality but slower
  TTFT and tighter VRAM headroom.

Smaller models (≤8B parameters) tend to hallucinate specifics (model numbers, dates, names) on
long-form content. If you summarize YouTube transcripts or long articles, prefer a 12B+ model.

## Limitations

- **No document attachments.** Ollama models don't accept PDFs; `--format markdown` with
  `--markdown-mode llm` still works (HTML in, markdown out), but binary `.pdf` inputs require an
  Anthropic/OpenAI/Google model that supports document attachments.
- **No native video understanding.** Use the transcript path (default for YouTube) instead of
  `--video-mode understand`.
- **Quality is bounded by the local model.** Don't expect GPT-5-class output from a 14B local
  model. Run an A/B against the same input to calibrate expectations.

## Transport details

Ollama is invoked via its OpenAI-compatible `/v1/chat/completions` endpoint. `summarize` forces
chat-completions mode (the OpenAI Responses API isn't supported by Ollama) and sends the model
id verbatim (`qwen3:14b`, not `openai/qwen3:14b`).

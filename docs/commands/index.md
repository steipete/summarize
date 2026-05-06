---
title: Commands
permalink: /docs/commands/
kicker: reference
summary: "Every summarize subcommand and flag, with examples."
---

# Command reference

`summarize` is one binary with a handful of subcommands. The default subcommand is `summarize` itself — the one you use 99% of the time. The others wrap related tooling.

## Subcommands

- [`summarize`](summarize.md) — main command. Takes a URL, file, or stdin and produces a summary or extracted content.
- [`summarize slides`](slides.md) — extract scene-change keyframes from a video URL into PNGs (and optional OCR text). Standalone version of the `--slides` flag.
- [`summarize transcriber`](transcriber.md) — set up local ONNX transcription (Parakeet, Canary). Prints the env vars you need.
- [`summarize daemon`](daemon.md) — manage the local HTTP daemon that the Chrome Side Panel talks to. Subcommands: `install`, `restart`, `status`, `uninstall`, `run`.
- [`summarize refresh-free`](refresh-free.md) — scan OpenRouter `:free` models, write working candidates to `~/.summarize/config.json`.

## Output discipline

All subcommands keep the same output discipline — straight from gogcli's playbook so pipes and scripts stay parseable:

- **stdout:** the result. Plain text, Markdown, JSON, or files (slides only).
- **stderr:** progress, prompts, warnings, and errors.
- `--json` produces a stable envelope on stdout.
- `--no-color` strips ANSI; `--plain` skips ANSI/OSC rendering for Markdown.

## Global behavior

These flags apply to almost every subcommand:

| Flag                          | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `--json`                      | Stable JSON envelope on stdout. Disables streaming.            |
| `--no-color`                  | Strip ANSI escapes from output.                                |
| `--theme <name>`              | Pick a CLI theme (`SUMMARIZE_THEME` env var also works).       |
| `--verbose` / `--debug`       | Detailed progress on stderr.                                   |
| `--metrics off\|on\|detailed` | Token + timing metrics line. Default `on`.                     |
| `--timeout <duration>`        | Cap fetching + LLM calls. Accepts `30`, `30s`, `2m`, `5000ms`. |
| `-V`, `--version`             | Print version and exit.                                        |
| `--help`                      | Print rich help with examples.                                 |

## Exit codes

| Code  | Meaning                                                |
| ----- | ------------------------------------------------------ |
| `0`   | Success.                                               |
| `1`   | Generic failure (extraction, model, network, parsing). |
| `2`   | Usage error (bad flag, bad input).                     |
| `124` | Timeout.                                               |

`summarize daemon` and `summarize transcriber` may surface platform-specific exit codes from the underlying service install (launchd, systemd, schtasks); check `--verbose` output for the raw error.

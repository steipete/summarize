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
- [`summarize status`](../cli.md#cli-discovery) — print the selected model, enabled providers, and runtime status.
- [`summarize slides`](slides.md) — extract scene-change keyframes from a YouTube URL, direct video URL, or local video file into PNGs (and optional OCR text). Standalone version of the `--slides` flag.
- [`summarize transcriber`](transcriber.md) — set up local ONNX transcription (Parakeet, Canary). Prints the env vars you need.
- [`summarize daemon`](daemon.md) — manage the local HTTP daemon that the Chrome Side Panel talks to. Subcommands: `install`, `restart`, `status`, `uninstall`, `run`.
- [`summarize refresh-free`](refresh-free.md) — scan OpenRouter `:free` models, write working candidates to `~/.summarize/config.json`.
- `summarize help [topic]` — print help for the CLI or a subcommand (`slides`, `status`, `daemon`, `transcriber`, `refresh-free`).

## Output discipline

All subcommands keep the same output discipline — straight from gogcli's playbook so pipes and scripts stay parseable:

- **stdout:** the result. Plain text, Markdown, JSON, or files (slides only).
- **stderr:** progress, prompts, warnings, and errors.
- `--json` produces a stable envelope on stdout.
- `--no-color` strips ANSI; `--plain` skips ANSI/OSC rendering for Markdown.

## Global behavior

Only two flags apply to every subcommand; the rest are per-command:

| Flag                          | Where it works                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--locale <locale>`           | Everywhere. Interface language: `auto` plus the shipped UI locales (`SUMMARIZE_LOCALE` too).                                               |
| `--help`                      | Everywhere (`summarize help <topic>` prints topic help).                                                                                   |
| `-V`, `--version`             | `summarize`, `summarize slides`.                                                                                                           |
| `--json`                      | `summarize`, `summarize slides`, `summarize status`.                                                                                       |
| `--no-color`                  | `summarize`, `summarize status`, `summarize refresh-free`, `summarize transcriber`.                                                        |
| `--theme <name>`              | `summarize`, `summarize slides`, `summarize transcriber` (`SUMMARIZE_THEME` env var also works).                                           |
| `--verbose` / `--debug`       | `summarize`, `summarize slides`, `summarize refresh-free`, `summarize daemon`, `summarize transcriber`. `status` accepts `--verbose` only. |
| `--metrics off\|on\|detailed` | `summarize` only.                                                                                                                          |
| `--timeout <duration>`        | `summarize`, `summarize slides`.                                                                                                           |

## Exit codes

| Code  | Meaning                                                                     |
| ----- | --------------------------------------------------------------------------- |
| `0`   | Success.                                                                    |
| `1`   | Any failure — usage errors, extraction, model, network, and timeouts alike. |
| `130` | Interrupted by SIGINT (Ctrl+C).                                             |
| `143` | Terminated by SIGTERM.                                                      |

`summarize daemon` and `summarize transcriber` still exit `1` when the underlying service install (launchd, systemd, schtasks) fails; the platform's own error text is included in the message — check `--verbose` output for the raw error.

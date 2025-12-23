# CLI models

Summarize can use installed CLIs (Claude, Codex, Gemini) as local model backends.

## Model ids

- `cli/claude/<model>` (e.g. `cli/claude/sonnet`)
- `cli/codex/<model>` (e.g. `cli/codex/gpt-5.2`)
- `cli/gemini/<model>` (e.g. `cli/gemini/gemini-3-flash-preview`)

Use `--cli [provider]` (case-insensitive) for the provider default, or `--model cli/<provider>/<model>` to pin a model.
If `--cli` is provided without a provider, auto selection is used with CLI enabled.

## Auto mode

Auto mode does **not** use CLIs unless you set `cli.enabled` in config.

Why: CLI adds ~4s latency per attempt and higher variance.
Recommendation: enable only Gemini unless you have a reason to add others.

Gemini CLI performance: summarize sets `GEMINI_CLI_NO_RELAUNCH=true` for Gemini CLI runs to avoid a costly self-relaunch (can be overridden by setting it yourself).

When enabled, auto prepends CLI attempts in the order listed in `cli.enabled`
(recommended: `["gemini"]`).

Enable CLI attempts:

```json
{
  "cli": { "enabled": ["gemini"] }
}
```

Disable CLI attempts:

```json
{
  "cli": { "enabled": [] }
}
```

Note: when `cli.enabled` is set, it also acts as an allowlist for explicit `--cli` / `--model cli/...`.

## CLI discovery

Binary lookup:

- `CLAUDE_PATH`, `CODEX_PATH`, `GEMINI_PATH` (optional overrides)
- Otherwise uses `PATH`

## Attachments (images/files)

When a CLI attempt is used for an image or non-text file, Summarize switches to a
path-based prompt and enables the required tool flags:

- Claude: `--tools Read --dangerously-skip-permissions`
- Gemini: `--yolo` and `--include-directories <dir>`
- Codex: `codex exec --output-last-message ...` and `-i <image>` for images

## Config

```json
{
  "cli": {
    "enabled": ["claude", "gemini", "codex"],
    "codex": { "model": "gpt-5.2" },
    "gemini": { "model": "gemini-3-flash-preview", "extraArgs": ["--verbose"] },
    "claude": {
      "model": "sonnet",
      "binary": "/usr/local/bin/claude",
      "extraArgs": ["--verbose"]
    }
  }
}
```

Notes:

- CLI output is treated as text only (no token accounting).
- If a CLI call fails, auto mode falls back to the next candidate.

## Generate free preset (OpenRouter)

`summarize` ships with a built-in preset `free`, backed by OpenRouter `:free` models.
To regenerate the candidate list (and persist it in your config):

```bash
summarize refresh-free
```

Options:

- `--runs 3` (default): timing runs per selected model (median)
- `--smart 3` (default): number of “smart-first” picks (rest filled by fastest)

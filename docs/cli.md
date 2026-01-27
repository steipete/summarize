---
summary: "CLI model providers and config for Claude, Codex, and Gemini."
read_when:
  - "When changing CLI model integration."
---

# CLI models

Summarize can use installed CLIs (Claude, Codex, Gemini, Cursor Agent) as local model backends.

## Model ids

- `cli/claude/<model>` (e.g. `cli/claude/sonnet`)
- `cli/codex/<model>` (e.g. `cli/codex/gpt-5.2`)
- `cli/gemini/<model>` (e.g. `cli/gemini/gemini-3-flash-preview`)
- `cli/agent/<model>` (e.g. `cli/agent/gpt-5.2`)

Use `--cli [provider]` (case-insensitive) for the provider default, or `--model cli/<provider>/<model>` to pin a model.
If `--cli` is provided without a provider, auto selection is used with CLI enabled.

## Auto mode

Auto mode does **not** use CLIs unless you set `cli.enabled` in config.

Why: CLI adds ~4s latency per attempt and higher variance.
Recommendation: enable only Gemini or Agent unless you have a reason to add others.

Gemini CLI performance: summarize sets `GEMINI_CLI_NO_RELAUNCH=true` for Gemini CLI runs to avoid a costly self-relaunch (can be overridden by setting it yourself).

When enabled, auto prepends CLI attempts in the order listed in `cli.enabled`
(recommended: `["gemini"]` or `["agent"]`).

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
- `AGENT_PATH` (optional override)
- Otherwise uses `PATH`

## Attachments (images/files)

When a CLI attempt is used for an image or non-text file, Summarize switches to a
path-based prompt and enables the required tool flags:

- Claude: `--tools Read --dangerously-skip-permissions`
- Gemini: `--yolo` and `--include-directories <dir>`
- Codex: `codex exec --output-last-message ...` and `-i <image>` for images
- Agent: uses built-in file tools in `agent --print` mode (no extra flags)

## Config

```json
{
  "cli": {
    "enabled": ["claude", "gemini", "codex", "agent"],
    "codex": { "model": "gpt-5.2" },
    "gemini": { "model": "gemini-3-flash-preview", "extraArgs": ["--verbose"] },
    "claude": {
      "model": "sonnet",
      "binary": "/usr/local/bin/claude",
      "extraArgs": ["--verbose"]
    },
    "agent": {
      "model": "gpt-5.2",
      "binary": "/usr/local/bin/agent"
    }
  }
}
```

Notes:

- CLI output is treated as text only (no token accounting).
- If a CLI call fails, auto mode falls back to the next candidate.
- Cursor Agent CLI uses the `agent` binary and relies on Cursor CLI auth (login or `CURSOR_API_KEY`).

## Generate free preset (OpenRouter)

`summarize` ships with a built-in preset `free`, backed by OpenRouter `:free` models.
To regenerate the candidate list (and persist it in your config):

```bash
summarize refresh-free
```

Options:

- `--runs 2` (default): extra timing runs per selected model (total runs = 1 + runs)
- `--smart 3` (default): number of “smart-first” picks (rest filled by fastest)
- `--set-default`: also sets `"model": "free"` in `~/.summarize/config.json`

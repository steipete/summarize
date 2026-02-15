# Title
Add first-class Kimi model support + stabilize slides/progress output

## Summary
This PR improves model/provider ergonomics and fixes multiple output stability issues seen in slides mode.

### 1) First-class Kimi support (similar to MiniMax)
- Add `--model kimi` alias (defaults to `openai/kimi-k2.5`)
- Add `--model kimi/<model>`
- Add provider env support:
  - `KIMI_API_KEY` (primary)
  - `MOONSHOT_API_KEY` (alias)
  - `KIMI_BASE_URL` (primary)
  - `MOONSHOT_BASE_URL` (alias)
  - default base URL: `https://api.moonshot.ai/v1`
- Wire Kimi handling through:
  - model parsing/spec
  - auto model candidate resolution
  - env/runtime context
  - URL and asset flows
  - daemon agent/flow context
  - help/docs

### 2) Kimi runtime compatibility fix
- Kimi rejects custom temperatures in this integration (`only 1 is allowed`).
- For `openai/kimi...` models, force effective `temperature=1` to avoid runtime failures.

### 3) Slides/progress output stabilization
- Fix progress gate behavior so spinner/progress rendering does not race against stdout output.
- Improve slides streaming/marker handling to avoid dropped interleaved text in chunked output.
- Preserve deterministic text output in non-inline terminals (fallback path still prints slide paths in debug/non-inline contexts).

### 4) Slide text fallback quality
- Improve transcript fallback segmentation for slide blocks:
  - reduce clipped starts
  - better boundary handling for continuation fragments
  - avoid over-aggressive replacement of long narrative bodies
- Add regression coverage around truncated/ellipsis and chunk boundary behavior.

## Why
Users reported:
- Needing cumbersome env remapping to use non-OpenAI-compatible providers.
- `--model minimax`/provider aliases not being symmetrical/extensible.
- Slides output truncation/misalignment and occasional paragraph clipping.
- Kimi calls failing due to temperature constraints.

This PR addresses those pain points directly.

## User-facing behavior changes
- New:
  - `summarize "<url>" --model kimi`
  - `summarize "<url>" --model kimi/<model-id>`
- Existing workflows remain supported.
- `--verbose` env diagnostics now include `kimiKey=true|false`.

## Docs
- `README.md`
- `docs/llm.md`
- `docs/config.md`
- CLI help text (`src/run/help.ts`)

## Tests
Added/updated coverage for:
- model spec parsing (`kimi`, `kimi/<model>`)
- auto model candidate support for Kimi aliases
- config env legacy key mapping (`apiKeys.kimi`)
- daemon agent key selection for Kimi
- temperature handling for Kimi
- slides text/stream/progress regressions

## Validation run
```bash
corepack pnpm exec vitest run \
  tests/model-spec.test.ts \
  tests/model-auto.test.ts \
  tests/config.env.test.ts \
  tests/daemon.agent.test.ts \
  tests/llm.generate-text.test.ts \
  tests/slides-output.stream-handler.test.ts \
  tests/slides-text.utils.test.ts \
  tests/progress-gate.test.ts

corepack pnpm exec tsc -p tsconfig.build.json
corepack pnpm exec node scripts/build-cli.mjs
```

## Notes / follow-up
- There is a local scratch file `tmp-coerce-check.ts` in the working tree; this should not be included in the final PR unless intentionally needed.
- This branch includes both provider and slides/progress work in one PR. If preferred, it can be split into:
  1. provider/model support (Kimi/MiniMax-related)
  2. slides/progress stability fixes

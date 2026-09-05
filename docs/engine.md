---
title: "Execution engine"
summary: "Headless summary execution shared by CLI and daemon adapters."
---

# Execution engine

`src/engine` owns summary policy and execution. It has no terminal, daemon, HTTP transport, or process UI dependencies.

CLI and daemon code remain adapters:

- CLI resolves command flags, owns progress and terminal rendering, then invokes engine modules.
- Daemon resolves request/config state, maps engine stream events to response chunks, and owns SSE/HTTP behavior.
- Browser code continues to depend on `@steipete/summarize-core`, not the Node execution engine.

## Module map

| Module                  | Responsibility                                                      |
| ----------------------- | ------------------------------------------------------------------- |
| `model-executor.ts`     | Provider/CLI calls, retries, streaming, token limits, usage         |
| `summary-execution.ts`  | Attempt order, cache reads/writes, fallback outcomes                |
| `web-summary.ts`        | URL summary attempts, short-content bypass, timestamp normalization |
| `web-prompt.ts`         | URL prompt construction and slide transcript budgeting              |
| `summary-timestamps.ts` | Timestamp bounds, sanitation, fallback key moments                  |
| `events.ts`             | Adapter-neutral summary stream contract                             |
| `errors.ts`             | Stable engine error-code guards                                     |
| `types.ts`              | Model attempts and typed execution results                          |
| `model-call.ts`         | Provider model resolution                                           |
| `streaming.ts`          | Stream capability and chunk normalization                           |

## Dependency rules

`src/engine/**` must not import:

- `src/run/**`
- `src/daemon/**`
- `src/tty/**`

The boundary test enforces this rule.

Engine modules may depend on portable domain/config modules, provider clients, cache interfaces, prompts, and injected runtime functions.

## Streaming

The engine never writes summary text to stdout.

Each provider attempt resolves one request shared by streaming, direct completion, and fallback completion. Stream consumption owns output-handler lifecycle and marks visible or handler failures as interrupted; only an uncommitted provider failure can fall back to completion. Usage collection happens after successful stream consumption and does not trigger another model call.

`SummaryStreamHandler` receives normalized chunks:

```ts
type SummaryStreamChunk = {
  streamed: string;
  prevStreamed: string;
  appended: string;
};
```

Adapters decide how to consume them:

- CLI: plain/ANSI rendering, line or delta mode, progress coordination
- daemon: response chunks and final newline
- slides: interleaved slide presentation

`SummaryAttemptResult.summaryEmitted` tells the adapter whether a stream handler already emitted the result. Cache hits and forced non-streaming calls return `false`, so the adapter writes the final summary once.

## Error routing

Fallback decisions use stable codes rather than message matching.

Asset-like responses discovered during HTML extraction throw `AssetLikeHtmlFetchError` with code `ASSET_LIKE_HTML_FETCH`. Input routing uses that code to retry the URL as an asset and optionally enable Firecrawl fallback.

The user-facing error text remains descriptive, but it is not a control-flow contract.

## Adapter ownership

Model selection resolves intent without creating process resources. `src/application/model-runtime.ts` then builds metrics, provider bindings, and the executable model in one factory; URL and asset flows share those same instances. Execution resources compose the flow contexts rather than rebuilding model options through intermediate factories.

`src/application/flow-contexts.ts` composes asset and URL contexts from the same IO, flags, model, and runtime hooks. Asset execution receives its flat context directly; `assetFormat` is the explicit asset-only override. Fetch tracking, shared caches, and summary-cache notifications stay wired at this application boundary.

Adapters own:

- stdout/stderr
- terminal capability and markdown rendering
- progress lifecycle and signals
- request/SSE serialization
- CLI fallback-state persistence callbacks
- cache/resource construction and cleanup

The engine owns:

- prompt policy
- model attempts and provider overrides
- summary cache keys and normalization
- stream normalization
- timestamp validation
- retry/fallback outcomes

Provider transport lives in `src/llm`. Generation and streaming share `LlmRequestOptions`, so prompt conversion and fallback attempts retain the original request settings. SDK-backed streaming providers share delta collection, deadlines, usage, and final-text handling; provider branches own model configuration and error normalization. OpenAI's HTTP transport keeps its separate response handling.

## Tests

Key coverage:

- engine import-boundary test
- model executor streaming with and without handlers
- terminal stream adapter output
- daemon cache and visible-page output
- typed asset-like HTML fallback routing
- URL prompt and timestamp normalization
- existing URL, asset, provider, cache, and CLI characterization suites

## Public API

`src/engine` is internal. It is not exported from the package root.

Any future public engine API needs a separate contract review for cancellation, resource ownership, error stability, and versioning.

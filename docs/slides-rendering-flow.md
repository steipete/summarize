---
title: "Slides rendering flow"
kicker: "internals"
summary: "Map of slide extraction terminal output and extension streaming flow."
read_when:
  - "When changing slide terminal output, streaming, or sidepanel state."
  - "When debugging slide rendering regressions in CLI or extension."
---

# Slides Rendering Flow

Two main paths.

## CLI / terminal

- `src/run/flows/url/slides-output.ts`
  Public construction + orchestration only.
- `slides-output-state.ts`
  Slide timeline state.
  Waiters.
  Finalization.
- `slides-output-render.ts`
  Terminal rendering.
  Inline-image policy.
  Debug path.
- `slides-output-stream.ts`
  Summary-stream parsing glue.

Rule: keep terminal I/O in render helpers; keep state mutations in the state store.

`src/slides/process.ts` owns media-tool spawning, deadlines, exit errors, and output collection. Line callbacks, text capture, and binary capture share that lifecycle; OCR uses binary capture to avoid logging recognized text. Ignored stdout is drained so child processes cannot block on a full pipe.

## Chrome extension

`background/content-script-bridge.ts` shares retry/reinjection handling across extraction, seeking, and frame preparation. Only extraction has a message deadline; capture startup and restoration keep their separate recovery policies and self-contained main-world scripts.

- `apps/chrome-extension/src/entrypoints/sidepanel/stream-controller.ts`
  Transport lifecycle.
- `stream-controller-policy.ts`
  Chunk/status terminal state rules.
- `apps/chrome-extension/src/lib/extension-logs.ts`
  Storage queue + flush only.
- `extension-log-format.ts`
  Pure log serialization/truncation.

Rule: push pure status/log logic out of adapters first.

## When debugging

1. Check state transitions before DOM issues.
2. Check stream policy before transport retry logic.
3. Check cache/hydration helpers before blaming rendering.

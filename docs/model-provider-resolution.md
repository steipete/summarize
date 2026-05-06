---
title: "Provider resolution"
kicker: "models"
summary: "Map of model auto-selection, provider capabilities, and LLM execution paths."
read_when:
  - "When changing auto model order or CLI fallback behavior."
  - "When adding provider capabilities or changing document/streaming support."
---

# Model / Provider Resolution

Goal: reduce implicit provider knowledge.

## Shared capability registry

- `src/llm/provider-capabilities.ts`
  Source of truth for:
  - required env per provider
  - CLI default models
  - auto CLI order
  - document support
  - streaming support

If a provider rule changes, update this file first.

## Auto model selection

- `src/model-auto.ts`
  Responsibilities:
  - resolve auto rules
  - prepend CLI candidates
  - map native candidates to OpenRouter when safe
  - emit attempts with required env + transport

Keep it selection-focused.
Do not add provider-specific capability branches there unless the registry cannot express them.

## Execution

- `src/llm/generate-text.ts`
  Responsibilities:
  - parse requested model id
  - validate input shape
  - route to provider transport
  - normalize retries / fallbacks

Provider-specific SDK/http details belong under `src/llm/providers/*`.

## Error shaping

- access / model availability normalization stays provider-local when truly provider-specific
- generic capability errors should come from the shared registry
- unsupported functionality errors should be thrown before transport setup

## Rules

- add capability once; consume it in `model-auto` and `generate-text`
- keep provider env alias handling centralized
- keep default CLI model changes in the registry, not scattered tests/constants

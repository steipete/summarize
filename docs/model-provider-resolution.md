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

- `src/llm/provider-registry.ts` is a dependency-free registry consumed by configuration, model parsing, and runtime capability helpers.
  It owns:
  - required env per provider
  - CLI default models
  - auto CLI order
  - document support
  - streaming support
  - provider names and their TypeScript unions
  - default endpoints and transport selection

If provider metadata changes, update the registry first. `src/llm/provider-profile.ts` owns runtime environment aliases and client configuration; `src/llm/provider-capabilities.ts` exposes their combined capability surface.

Configuration-only allowlists stay separate: legacy `apiKeys` names belong to `src/config/legacy-api-keys.ts`, and provider base-URL sections remain an explicit supported configuration surface. Adding a model provider must not implicitly expand either.

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

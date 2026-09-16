---
title: "Language"
kicker: "modes"
summary: "Output language flag and config options."
read_when:
  - "When changing language handling."
---

# Output language

By default, `summarize` writes the summary in the **same language as the source content** (`--language auto`). If language detection is uncertain, it falls back to English.

This affects the language of the generated summary text (not extraction/transcription).

## CLI

```bash
summarize <input> --language auto
summarize <input> --language en
summarize <input> --language de
summarize <input> --language english
summarize <input> --lang german
summarize <input> --language tr
summarize <input> --language turkish
```

Supported inputs (best-effort):

- `auto` (default): match the source language
- Common shorthands: `en`, `de`, `es`, `fr`, ...
- Common names: `english`, `german`/`deutsch`, `spanish`, ...
- Turkish aliases: `tr`, `tr-TR`, `turkish`, and `Türkçe`/`turkce`
- BCP-47-ish tags: `en-US`, `pt-BR`, ...
- Free-form hints: `German, formal`

## Config default

Preferred:

```json
{
  "output": { "language": "auto" }
}
```

Legacy (still supported):

```json
{
  "language": "en"
}
```

Unknown values are passed through to the model (sanitized).

## Interface language

`--language` controls the generated summary independently of the CLI and extension interface. Use `--locale de` (or `SUMMARIZE_LOCALE=de`) for German help, progress, and status text. Without an explicit preference, the CLI follows the system locale; unsupported preferences fall through to the system locale and then English. Command names, flags, model/provider IDs, URLs, paths, and protocol identifiers retain their spelling. Native and provider diagnostics remain opaque; Summarize’s own guidance is localized.

In the extension, choose **Interface language** in **Options → UI**. **Automatic** follows the browser’s language preferences. An explicitly saved locale takes precedence, while profiles without one follow the browser. Changing the setting updates an already-open side panel without translating summary content, user data, or diagnostic log payloads.

See [Localization](localization.md) for the complete fourteen-language set, regional fallbacks, catalogs, glossaries, and contributor checks.

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

## CLI language

`--language` selects the language of the generated summary. It does not translate
the command-line interface. Use `--locale tr` (or `SUMMARIZE_LOCALE=tr`) for
Turkish help, progress, and status text. The CLI remains English by default;
unknown locales fall back to English. Command names, flags, model/provider IDs,
URLs, paths, and protocol identifiers are never translated.
Raw diagnostics and provider error messages retain their original text.

## Extension interface language

Choose English, Turkish, or Automatic under Options → User interface. Existing
profiles keep English until you choose a locale; fresh installations use the
browser language. The setting updates an already-open side panel immediately.
It does not translate summary content, user data, or diagnostic log payloads.

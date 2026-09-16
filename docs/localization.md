---
summary: "UI locale selection, message catalogs, translation rules, and completeness checks."
read_when:
  - "Adding or changing CLI or extension interface text"
  - "Adding a UI language or troubleshooting locale selection"
---

# Localization

Summarize localizes its CLI and Chrome/Firefox extension interface in English, German, French, Spanish, Italian, Brazilian Portuguese, Dutch, Polish, Russian, Japanese, Simplified Chinese, Traditional Chinese, Korean, and Turkish. Summary and transcript content remain independent of the interface language.

## Choosing a language

| Locale    | Language                    |
| --------- | --------------------------- |
| `en`      | English (base and fallback) |
| `de`      | German                      |
| `fr`      | French                      |
| `es`      | Spanish                     |
| `it`      | Italian                     |
| `pt-BR`   | Portuguese (Brazil)         |
| `nl`      | Dutch                       |
| `pl`      | Polish                      |
| `ru`      | Russian                     |
| `ja`      | Japanese                    |
| `zh-Hans` | Simplified Chinese          |
| `zh-Hant` | Traditional Chinese         |
| `ko`      | Korean                      |
| `tr`      | Turkish                     |

Use `summarize --locale de --help` or `SUMMARIZE_LOCALE=de` for the CLI. In the extension, choose **Interface language** in **Options → UI**. An explicit selection takes precedence over the operating system or browser preferences. `auto` follows those preferences, with English as the final fallback. The CLI reads `LC_ALL`, `LC_MESSAGES`, then `LANG`, or the platform locale when those are absent. `--locale` takes precedence over `SUMMARIZE_LOCALE`.

Regional and script variants negotiate to a registered catalog: `de-AT` becomes `de`, Portuguese locales use `pt-BR`, `zh-TW` and `zh-HK` use `zh-Hant`, and `zh-CN` uses `zh-Hans`. Explicit Chinese script tags take precedence over the region. Only fully registered locales appear in the interface selector or CLI help.

`--language` and the extension’s summary language setting control generated content, independently of UI locale. For example:

```sh
summarize --locale de --language japanese "https://example.com/article"
```

This uses German controls and progress messages while requesting a Japanese summary. Extracted article text, user prompts, skill names, file paths, URLs, provider/model identifiers, and native/provider diagnostics retain their original content.

## Catalog ownership

English is the base catalog. There are two effective surface catalogs, composed from shared messages plus surface-specific messages:

| Catalog group | Location                                                | Owner                                                                |
| ------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Shared        | `packages/core/src/localization/catalogs/<locale>.json` | Messages used by both surfaces or carried across the daemon boundary |
| CLI           | `src/localization/<locale>.json`                        | Help, terminal presentation, and CLI-only commands                   |
| Extension     | `apps/chrome-extension/src/localization/<locale>.json`  | Options, side panel, and browser-owned interface messages            |

A shared key must not be duplicated in either surface catalog. Both surfaces use `createTranslator` from `@steipete/summarize-core/localization`. `sharedMessageCatalogs` is the locale registry; each adapter must load a catalog for every registered locale. The English catalog defines the TypeScript key union, so callers do not maintain a second key list.

New keys describe intent, such as `service.commandError`, `skills.deleteConfirm`, or `progress.panelExtract`. Keep keys stable when wording changes. Some existing keys derive from older English copy; use semantic names for new messages. Separate product branding (`brand.name`) from the summarization action (`summarize`). Product and provider names stay unchanged in each locale’s explicit entry.

## Writing messages

Translate complete messages. Pass user data as values, rather than concatenating translated fragments or searching for English text to replace. ICU `plural` and `select` expressions let translators control word order, grammar, and optional clauses:

```json
{
  "files.ready": "{count, plural, one {# file ready} other {# files ready}}",
  "job.state": "{state, select, running {Running} other {Waiting}}"
}
```

Keep placeholder names and types consistent. Preserve exact plural cases such as `=0` and offsets; add the plural categories required by the target language. Polish and Russian need more categories than English, while Japanese and Chinese generally use `other`. Do not translate selector identifiers, flags, environment variable names, model IDs, or literal command placeholders. ICU quoting preserves literal braces, for example `'{input}'`.

Use ICU number/date arguments or `Intl` formatting at the rendering boundary. Keep numbers numeric in messages sent between processes. CLI emphasis uses the reserved `<uiLabel>`, `<uiDetail>`, and `<uiValue>` tags; these style complete messages without interpreting interpolated data as markup.

Use typed helpers (`cliMessage`, `sharedMessage`, or extension `message`) for descriptors. CLI `CliError` and extension `LocalizedError` retain owned error descriptors through catches. Nested owned errors stay structured until the final UI renders them; opaque provider or operating-system details stay literal. Daemon and background events carry optional localization descriptors alongside compatibility text. Validate incoming descriptors with `readLocalizedMessage` before rendering.

For extension DOM text, use `setText`, `setLocalizedAttribute`, `LocalizedText`, or `data-i18n` bindings. Attribute bindings include titles, placeholders, accessible labels, and visible `value`/`label` attributes. Use `localizedHtml` when an existing template needs a localized text node; it escapes text and values. Source and user content belongs in the literal-content path, with `data-locale-ignore` where needed. Locale changes must not rewrite that content.

Use logical CSS properties (`padding-inline`, `margin-inline`, `text-align: start`) and isolate URLs, code, and tokens from surrounding text direction. The root direction is derived from the locale; user content can use `dir="auto"`. Check long labels at normal options and side-panel widths.

## Adding a language

1. Add the language tag to `UI_LOCALES` and update negotiation only if its region/script rules require it.
2. Create `<locale>.json` in all three catalog groups, translating every English key. Consult the per-locale glossaries in `docs/localization/glossaries/` and add a glossary for the new locale.
3. Import and register the shared catalog in `packages/core/src/localization/messages.ts`, and import the surface catalogs in the CLI and extension adapters. Their exhaustive registry types prevent partially loaded languages.
4. Test explicit selection, platform negotiation, region/script fallback, plural branches, and independence from summary language. Build the CLI and both extension targets. Inspect options and the side panel, including long labels and translated errors.
5. Run `pnpm check:localization` and `pnpm check`. Include synthetic UI proof when changing the extension, and update the language list and changelog.

## Completeness enforcement

`pnpm check:localization` runs the same check used by CI and `pnpm check`. It rejects missing or unregistered locale files, missing or stale keys, malformed ICU, placeholder/type/selector mismatches, duplicate shared keys, unused keys, unknown keys, and references to keys owned only by the other surface.

The source audit checks static HTML and JSX bindings, embedded markup, visible DOM attributes, display calls, and local values passed into presentation code. It follows common constants, aliases, object members, and destructuring, and rejects English-text matching used as a translation mechanism. Tests cover deliberate bypasses, including a deliberately incomplete catalog that must make the check exit unsuccessfully.

Some strings are executable syntax, model instructions, external diagnostics, or source data. Keep exceptions narrow and adjacent to the expression, using an `i18n-ignore:` comment that explains the boundary. A comment cannot exempt an entire function or control-flow block. `data-locale-ignore` protects runtime source content; it is not permission to put uncatalogued interface copy in static HTML.

An intentionally untranslated message can use an explicit marker:

```json
{
  "example.message": {
    "fallback": "en",
    "reason": "Explain the specific reviewed exception."
  }
}
```

The marker requires a nonempty reason and renders using English grammar. Reviewers must assess the exception; missing translations cannot silently pass CI. The shipped language catalogs are complete translations and do not need fallback markers.

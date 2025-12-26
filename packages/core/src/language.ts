const NORMALIZE_PATTERN = /[^a-z0-9-]+/g

export type OutputLanguage =
  | { kind: 'auto' }
  | {
      kind: 'fixed'
      /**
       * BCP-47-ish language tag (e.g. "en", "de", "en-US").
       *
       * Note: we keep this mostly user-provided; the model does the heavy lifting.
       */
      tag: string
      /**
       * Human-friendly label for prompts (e.g. "English", "German").
       */
      label: string
    }

const LANGUAGE_ALIASES: Record<string, { tag: string; label: string }> = {
  en: { tag: 'en', label: 'English' },
  'en-us': { tag: 'en-US', label: 'English' },
  'en-gb': { tag: 'en-GB', label: 'English' },
  english: { tag: 'en', label: 'English' },

  de: { tag: 'de', label: 'German' },
  'de-de': { tag: 'de-DE', label: 'German' },
  german: { tag: 'de', label: 'German' },
  deutsch: { tag: 'de', label: 'German' },

  es: { tag: 'es', label: 'Spanish' },
  'es-es': { tag: 'es-ES', label: 'Spanish' },
  'es-mx': { tag: 'es-MX', label: 'Spanish' },
  spanish: { tag: 'es', label: 'Spanish' },
  espanol: { tag: 'es', label: 'Spanish' },

  fr: { tag: 'fr', label: 'French' },
  french: { tag: 'fr', label: 'French' },

  it: { tag: 'it', label: 'Italian' },
  italian: { tag: 'it', label: 'Italian' },

  pt: { tag: 'pt', label: 'Portuguese' },
  'pt-br': { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  'pt-pt': { tag: 'pt-PT', label: 'Portuguese (Portugal)' },
  portuguese: { tag: 'pt', label: 'Portuguese' },

  nl: { tag: 'nl', label: 'Dutch' },
  dutch: { tag: 'nl', label: 'Dutch' },

  sv: { tag: 'sv', label: 'Swedish' },
  swedish: { tag: 'sv', label: 'Swedish' },

  no: { tag: 'no', label: 'Norwegian' },
  norwegian: { tag: 'no', label: 'Norwegian' },

  da: { tag: 'da', label: 'Danish' },
  danish: { tag: 'da', label: 'Danish' },

  fi: { tag: 'fi', label: 'Finnish' },
  finnish: { tag: 'fi', label: 'Finnish' },

  pl: { tag: 'pl', label: 'Polish' },
  polish: { tag: 'pl', label: 'Polish' },

  cs: { tag: 'cs', label: 'Czech' },
  czech: { tag: 'cs', label: 'Czech' },

  tr: { tag: 'tr', label: 'Turkish' },
  turkish: { tag: 'tr', label: 'Turkish' },

  ru: { tag: 'ru', label: 'Russian' },
  russian: { tag: 'ru', label: 'Russian' },

  uk: { tag: 'uk', label: 'Ukrainian' },
  ukrainian: { tag: 'uk', label: 'Ukrainian' },

  zh: { tag: 'zh', label: 'Chinese' },
  'zh-cn': { tag: 'zh-CN', label: 'Chinese (Simplified)' },
  'zh-hans': { tag: 'zh-Hans', label: 'Chinese (Simplified)' },
  'zh-tw': { tag: 'zh-TW', label: 'Chinese (Traditional)' },
  'zh-hant': { tag: 'zh-Hant', label: 'Chinese (Traditional)' },
  chinese: { tag: 'zh', label: 'Chinese' },

  ja: { tag: 'ja', label: 'Japanese' },
  japanese: { tag: 'ja', label: 'Japanese' },

  ko: { tag: 'ko', label: 'Korean' },
  korean: { tag: 'ko', label: 'Korean' },

  ar: { tag: 'ar', label: 'Arabic' },
  arabic: { tag: 'ar', label: 'Arabic' },

  hi: { tag: 'hi', label: 'Hindi' },
  hindi: { tag: 'hi', label: 'Hindi' },
}

const looksLikeLanguageTag = (value: string): boolean =>
  // Keep this loose: the model can handle tags like "en-US" or "pt-BR".
  /^[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{2,8})*$/.test(value)

function normalizeLanguageTag(value: string): string {
  const parts = value
    .replaceAll('_', '-')
    .split('-')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return value
  const [headRaw, ...rest] = parts
  const head = headRaw.toLowerCase()
  const tail = rest.map((p) =>
    p.length === 2 ? p.toUpperCase() : p.slice(0, 1).toUpperCase() + p.slice(1)
  )
  return [head, ...tail].join('-')
}

function sanitizeFreeForm(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.replaceAll(/\s+/g, ' ').slice(0, 64)
}

export function parseOutputLanguage(raw: string): OutputLanguage {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Invalid --language: must not be empty.')
  }
  const compact = trimmed
    .toLowerCase()
    .replaceAll('_', '-')
    .replaceAll(NORMALIZE_PATTERN, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
  if (compact === 'auto') return { kind: 'auto' }

  const alias = LANGUAGE_ALIASES[compact]
  if (alias) return { kind: 'fixed', tag: alias.tag, label: alias.label }

  if (looksLikeLanguageTag(trimmed)) {
    const tag = normalizeLanguageTag(trimmed)
    return { kind: 'fixed', tag, label: tag }
  }

  const freeForm = sanitizeFreeForm(trimmed)
  return { kind: 'fixed', tag: freeForm, label: freeForm }
}

export function resolveOutputLanguage(raw: string | null | undefined): OutputLanguage {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return { kind: 'auto' }
  try {
    return parseOutputLanguage(value)
  } catch {
    return { kind: 'auto' }
  }
}

export function formatOutputLanguageInstruction(language: OutputLanguage): string {
  if (language.kind === 'auto') {
    return 'Write the answer in the primary language of the source content.'
  }
  return `Write the answer in ${language.label}.`
}

export function formatOutputLanguageForJson(
  language: OutputLanguage
): { mode: 'auto' } | { mode: 'fixed'; tag: string; label: string } {
  return language.kind === 'auto'
    ? { mode: 'auto' }
    : { mode: 'fixed', tag: language.tag, label: language.label }
}

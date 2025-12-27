export const colorSchemes = ['slate', 'cedar', 'mint', 'ocean', 'ember', 'iris'] as const
export type ColorScheme = (typeof colorSchemes)[number]

export const colorModes = ['system', 'light', 'dark'] as const
export type ColorMode = (typeof colorModes)[number]

export const defaultColorScheme: ColorScheme = 'slate'
export const defaultColorMode: ColorMode = 'system'

function normalizeValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().toLowerCase() as T
  if (!trimmed) return fallback
  return (allowed as readonly string[]).includes(trimmed) ? (trimmed as T) : fallback
}

export function normalizeColorScheme(value: unknown): ColorScheme {
  return normalizeValue(value, colorSchemes, defaultColorScheme)
}

export function normalizeColorMode(value: unknown): ColorMode {
  return normalizeValue(value, colorModes, defaultColorMode)
}

export function applyTheme(opts: { scheme: ColorScheme; mode: ColorMode }) {
  const root = document.documentElement
  root.dataset.theme = opts.scheme
  root.dataset.mode = opts.mode
  root.style.colorScheme = opts.mode === 'system' ? 'light dark' : opts.mode
}

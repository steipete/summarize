import type { CliProvider, SummarizeConfig } from '../config.js'
import { loadSummarizeConfig } from '../config.js'
import { parseVideoMode } from '../flags.js'
import { type OutputLanguage, parseOutputLanguage } from '../language.js'
import { parseBooleanEnv } from './env.js'

export type ConfigState = {
  config: SummarizeConfig | null
  configPath: string | null
  outputLanguage: OutputLanguage
  openaiWhisperUsdPerMinute: number
  videoMode: ReturnType<typeof parseVideoMode>
  cliConfigForRun: SummarizeConfig['cli'] | undefined
  configForCli: SummarizeConfig | null
  openaiUseChatCompletions: boolean
  configModelLabel: string | null
}

export function resolveConfigState({
  envForRun,
  programOpts,
  languageExplicitlySet,
  videoModeExplicitlySet,
  cliFlagPresent,
  cliProviderArg,
}: {
  envForRun: Record<string, string | undefined>
  programOpts: Record<string, unknown>
  languageExplicitlySet: boolean
  videoModeExplicitlySet: boolean
  cliFlagPresent: boolean
  cliProviderArg: CliProvider | null
}): ConfigState {
  const { config, path: configPath } = loadSummarizeConfig({ env: envForRun })
  const cliLanguageRaw =
    typeof programOpts.language === 'string'
      ? (programOpts.language as string)
      : typeof programOpts.lang === 'string'
        ? (programOpts.lang as string)
        : null
  const defaultLanguageRaw = (config?.output?.language ?? config?.language ?? 'auto') as string
  const outputLanguage: OutputLanguage = parseOutputLanguage(
    languageExplicitlySet && typeof cliLanguageRaw === 'string' && cliLanguageRaw.trim().length > 0
      ? cliLanguageRaw
      : defaultLanguageRaw
  )
  const openaiWhisperUsdPerMinute = (() => {
    const value = config?.openai?.whisperUsdPerMinute
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0.006
  })()
  const videoMode = parseVideoMode(
    videoModeExplicitlySet
      ? (programOpts.videoMode as string)
      : (config?.media?.videoMode ?? (programOpts.videoMode as string))
  )

  const cliEnabledOverride: CliProvider[] | null = (() => {
    if (!cliFlagPresent || cliProviderArg) return null
    if (Array.isArray(config?.cli?.enabled)) return config.cli.enabled
    return ['gemini', 'claude', 'codex', 'agent']
  })()
  const cliConfigForRun = cliEnabledOverride
    ? { ...(config?.cli ?? {}), enabled: cliEnabledOverride }
    : config?.cli
  const configForCli: SummarizeConfig | null =
    cliEnabledOverride !== null
      ? { ...(config ?? {}), ...(cliConfigForRun ? { cli: cliConfigForRun } : {}) }
      : config

  const openaiUseChatCompletions = (() => {
    const envValue = parseBooleanEnv(
      typeof envForRun.OPENAI_USE_CHAT_COMPLETIONS === 'string'
        ? envForRun.OPENAI_USE_CHAT_COMPLETIONS
        : null
    )
    if (envValue !== null) return envValue
    const configValue = config?.openai?.useChatCompletions
    return typeof configValue === 'boolean' ? configValue : false
  })()

  const configModelLabel = (() => {
    const model = config?.model
    if (!model) return null
    if ('id' in model) return model.id
    if ('name' in model) return model.name
    if ('mode' in model && model.mode === 'auto') return 'auto'
    return null
  })()

  return {
    config,
    configPath,
    outputLanguage,
    openaiWhisperUsdPerMinute,
    videoMode,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
    configModelLabel,
  }
}

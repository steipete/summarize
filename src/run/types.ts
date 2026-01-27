import type { CliProvider } from '../config.js'

export type ModelAttemptRequiredEnv =
  | 'XAI_API_KEY'
  | 'OPENAI_API_KEY'
  | 'GEMINI_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'Z_AI_API_KEY'
  | 'CLI_CLAUDE'
  | 'CLI_CODEX'
  | 'CLI_GEMINI'
  | 'CLI_AGENT'

export type ModelAttempt = {
  transport: 'native' | 'openrouter' | 'cli'
  userModelId: string
  llmModelId: string | null
  openrouterProviders: string[] | null
  forceOpenRouter: boolean
  requiredEnv: ModelAttemptRequiredEnv
  openaiBaseUrlOverride?: string | null
  openaiApiKeyOverride?: string | null
  forceChatCompletions?: boolean
  cliProvider?: CliProvider
  cliModel?: string | null
}

export type ModelMeta = {
  provider: 'xai' | 'openai' | 'google' | 'anthropic' | 'zai' | 'cli'
  canonical: string
}

export type MarkdownModel = {
  llmModelId: string
  forceOpenRouter: boolean
  openaiApiKeyOverride?: string | null
  openaiBaseUrlOverride?: string | null
  forceChatCompletions?: boolean
  requiredEnv?: ModelAttemptRequiredEnv
}

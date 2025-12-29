import type { LlmTokenUsage } from './types.js'

export function normalizeTokenUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as { input?: unknown; output?: unknown; totalTokens?: unknown }

  const promptTokens =
    typeof usage.input === 'number' && Number.isFinite(usage.input) ? usage.input : null
  const completionTokens =
    typeof usage.output === 'number' && Number.isFinite(usage.output) ? usage.output : null
  const totalTokens =
    typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
      ? usage.totalTokens
      : null

  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

export function normalizeAnthropicUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as { input_tokens?: unknown; output_tokens?: unknown }
  const promptTokens =
    typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : null
  const completionTokens =
    typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : null
  const totalTokens =
    typeof promptTokens === 'number' && typeof completionTokens === 'number'
      ? promptTokens + completionTokens
      : null
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

export function normalizeOpenAiUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
  const promptTokens =
    typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : null
  const completionTokens =
    typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : null
  const totalTokens =
    typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : typeof promptTokens === 'number' && typeof completionTokens === 'number'
        ? promptTokens + completionTokens
        : null
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

export function normalizeGoogleUsage(raw: unknown): LlmTokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const usage = raw as {
    promptTokenCount?: unknown
    candidatesTokenCount?: unknown
    totalTokenCount?: unknown
  }
  const promptTokens =
    typeof usage.promptTokenCount === 'number' && Number.isFinite(usage.promptTokenCount)
      ? usage.promptTokenCount
      : null
  const completionTokens =
    typeof usage.candidatesTokenCount === 'number' &&
    Number.isFinite(usage.candidatesTokenCount)
      ? usage.candidatesTokenCount
      : null
  const totalTokens =
    typeof usage.totalTokenCount === 'number' && Number.isFinite(usage.totalTokenCount)
      ? usage.totalTokenCount
      : typeof promptTokens === 'number' && typeof completionTokens === 'number'
        ? promptTokens + completionTokens
        : null
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null
  return { promptTokens, completionTokens, totalTokens }
}

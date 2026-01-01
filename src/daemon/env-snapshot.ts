const ENV_KEYS = [
  'PATH',
  'XAI_API_KEY',
  'XAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENAI_USE_CHAT_COMPLETIONS',
  'Z_AI_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_BASE_URL',
  'ZAI_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_BASE_URL',
  'GEMINI_BASE_URL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'FIRECRAWL_API_KEY',
  'APIFY_API_TOKEN',
  'YT_DLP_PATH',
  'FAL_KEY',
  'SUMMARIZE_MODEL',
  'SUMMARIZE_TRANSCRIBER',
  'SUMMARIZE_ONNX_PARAKEET_CMD',
  'SUMMARIZE_ONNX_CANARY_CMD',
  'CLAUDE_PATH',
  'CODEX_PATH',
  'GEMINI_PATH',
  'UVX_PATH',
] as const

export type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string>>

export function buildEnvSnapshotFromEnv(env: Record<string, string | undefined>): EnvSnapshot {
  const out: EnvSnapshot = {}
  for (const key of ENV_KEYS) {
    const raw = env[key]
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value) continue
    out[key] = value
  }
  return out
}

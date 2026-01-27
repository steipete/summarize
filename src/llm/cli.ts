import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CliConfig, CliProvider } from '../config.js'
import type { ExecFileFn } from '../markitdown.js'
import type { LlmTokenUsage } from './generate-text.js'

const DEFAULT_BINARIES: Record<CliProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  agent: 'agent',
}

const PROVIDER_PATH_ENV: Record<CliProvider, string> = {
  claude: 'CLAUDE_PATH',
  codex: 'CODEX_PATH',
  gemini: 'GEMINI_PATH',
  agent: 'AGENT_PATH',
}

type RunCliModelOptions = {
  provider: CliProvider
  prompt: string
  model: string | null
  allowTools: boolean
  timeoutMs: number
  env: Record<string, string | undefined>
  execFileImpl?: ExecFileFn
  config: CliConfig | null
  cwd?: string
  extraArgs?: string[]
}

type CliRunResult = {
  text: string
  usage: LlmTokenUsage | null
  costUsd: number | null
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export function isCliDisabled(
  provider: CliProvider,
  config: CliConfig | null | undefined
): boolean {
  if (!config) return false
  if (Array.isArray(config.enabled) && !config.enabled.includes(provider)) return true
  return false
}

export function resolveCliBinary(
  provider: CliProvider,
  config: CliConfig | null | undefined,
  env: Record<string, string | undefined>
): string {
  const providerConfig =
    provider === 'claude'
      ? config?.claude
      : provider === 'codex'
        ? config?.codex
        : provider === 'gemini'
          ? config?.gemini
          : config?.agent
  if (isNonEmptyString(providerConfig?.binary)) return providerConfig.binary.trim()
  const pathKey = PROVIDER_PATH_ENV[provider]
  if (isNonEmptyString(env[pathKey])) return env[pathKey].trim()
  const envKey = `SUMMARIZE_CLI_${provider.toUpperCase()}`
  if (isNonEmptyString(env[envKey])) return env[envKey].trim()
  return DEFAULT_BINARIES[provider]
}

async function execCliWithInput({
  execFileImpl,
  cmd,
  args,
  input,
  timeoutMs,
  env,
  cwd,
}: {
  execFileImpl: ExecFileFn
  cmd: string
  args: string[]
  input: string
  timeoutMs: number
  env: Record<string, string | undefined>
  cwd?: string
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = execFileImpl(
      cmd,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        cwd,
        maxBuffer: 50 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrText =
            typeof stderr === 'string' ? stderr : (stderr as Buffer).toString('utf8')
          const message = stderrText.trim()
            ? `${error.message}: ${stderrText.trim()}`
            : error.message
          reject(new Error(message, { cause: error }))
          return
        }
        const stdoutText = typeof stdout === 'string' ? stdout : (stdout as Buffer).toString('utf8')
        const stderrText = typeof stderr === 'string' ? stderr : (stderr as Buffer).toString('utf8')
        resolve({ stdout: stdoutText, stderr: stderrText })
      }
    )
    if (child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

const parseJsonFromOutput = (output: string): unknown | null => {
  const trimmed = output.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // fall through
    }
  }
  const lastBraceIndex = trimmed.lastIndexOf('\n{')
  if (lastBraceIndex >= 0) {
    const candidate = trimmed.slice(lastBraceIndex + 1).trim()
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      return null
    }
  }
  return null
}

const toNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

const parseClaudeUsage = (payload: Record<string, unknown>): LlmTokenUsage | null => {
  const usage = payload.usage
  if (!usage || typeof usage !== 'object') return null
  const usageRecord = usage as Record<string, unknown>
  const inputTokens = toNumber(usageRecord.input_tokens)
  const cacheCreationTokens = toNumber(usageRecord.cache_creation_input_tokens) ?? 0
  const cacheReadTokens = toNumber(usageRecord.cache_read_input_tokens) ?? 0
  const outputTokens = toNumber(usageRecord.output_tokens)
  if (inputTokens === null && outputTokens === null) return null
  const promptTokens =
    inputTokens !== null ? inputTokens + cacheCreationTokens + cacheReadTokens : null
  const completionTokens = outputTokens
  const totalTokens =
    typeof promptTokens === 'number' && typeof completionTokens === 'number'
      ? promptTokens + completionTokens
      : null
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  }
}

const parseGeminiUsage = (payload: Record<string, unknown>): LlmTokenUsage | null => {
  const stats = payload.stats
  if (!stats || typeof stats !== 'object') return null
  const models = (stats as Record<string, unknown>).models
  if (!models || typeof models !== 'object') return null
  let promptSum = 0
  let completionSum = 0
  let totalSum = 0
  let hasPrompt = false
  let hasCompletion = false
  let hasTotal = false
  for (const entry of Object.values(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const tokens = (entry as Record<string, unknown>).tokens
    if (!tokens || typeof tokens !== 'object') continue
    const prompt = toNumber((tokens as Record<string, unknown>).prompt)
    const candidates = toNumber((tokens as Record<string, unknown>).candidates)
    const total = toNumber((tokens as Record<string, unknown>).total)
    if (typeof prompt === 'number') {
      promptSum += prompt
      hasPrompt = true
    }
    if (typeof candidates === 'number') {
      completionSum += candidates
      hasCompletion = true
    }
    if (typeof total === 'number') {
      totalSum += total
      hasTotal = true
    }
  }
  if (!hasPrompt && !hasCompletion && !hasTotal) return null
  const promptTokens = hasPrompt ? promptSum : null
  const completionTokens = hasCompletion ? completionSum : null
  const totalTokens =
    hasTotal && totalSum > 0
      ? totalSum
      : typeof promptTokens === 'number' && typeof completionTokens === 'number'
        ? promptTokens + completionTokens
        : null
  return { promptTokens, completionTokens, totalTokens }
}

const parseCodexUsageFromJsonl = (
  output: string
): { usage: LlmTokenUsage | null; costUsd: number | null } => {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let usage: LlmTokenUsage | null = null
  let costUsd: number | null = null
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const candidates = [
        parsed.usage,
        (parsed.response as Record<string, unknown> | undefined)?.usage,
        (parsed.metrics as Record<string, unknown> | undefined)?.usage,
      ].filter(Boolean) as Record<string, unknown>[]
      for (const candidate of candidates) {
        const input =
          toNumber(candidate.input_tokens) ??
          toNumber(candidate.prompt_tokens) ??
          toNumber(candidate.inputTokens) ??
          null
        const outputTokens =
          toNumber(candidate.output_tokens) ??
          toNumber(candidate.completion_tokens) ??
          toNumber(candidate.outputTokens) ??
          null
        const totalTokens =
          toNumber(candidate.total_tokens) ??
          toNumber(candidate.totalTokens) ??
          (typeof input === 'number' && typeof outputTokens === 'number'
            ? input + outputTokens
            : null)
        if (input !== null || outputTokens !== null || totalTokens !== null) {
          usage = { promptTokens: input, completionTokens: outputTokens, totalTokens }
        }
      }
      if (costUsd === null) {
        const costValue =
          toNumber(parsed.cost_usd) ??
          toNumber((parsed.usage as Record<string, unknown> | undefined)?.cost_usd) ??
          null
        if (typeof costValue === 'number') costUsd = costValue
      }
    } catch {
      // ignore malformed JSON lines
    }
  }
  return { usage, costUsd }
}

export async function runCliModel({
  provider,
  prompt,
  model,
  allowTools,
  timeoutMs,
  env,
  execFileImpl,
  config,
  cwd,
  extraArgs,
}: RunCliModelOptions): Promise<CliRunResult> {
  const execFileFn = execFileImpl ?? execFile
  const binary = resolveCliBinary(provider, config, env)
  const args: string[] = []

  const effectiveEnv =
    provider === 'gemini' && !isNonEmptyString(env.GEMINI_CLI_NO_RELAUNCH)
      ? { ...env, GEMINI_CLI_NO_RELAUNCH: 'true' }
      : env

  const providerConfig =
    provider === 'claude' ? config?.claude : provider === 'codex' ? config?.codex : config?.gemini

  if (providerConfig?.extraArgs?.length) {
    args.push(...providerConfig.extraArgs)
  }
  if (extraArgs?.length) {
    args.push(...extraArgs)
  }
  if (provider === 'codex') {
    const outputDir = await fs.mkdtemp(path.join(tmpdir(), 'summarize-codex-'))
    const outputPath = path.join(outputDir, 'last-message.txt')
    args.push('exec', '--output-last-message', outputPath, '--skip-git-repo-check', '--json')
    if (model && model.trim().length > 0) {
      args.push('-m', model.trim())
    }
    const hasVerbosityOverride = args.some((arg) => arg.includes('text.verbosity'))
    if (!hasVerbosityOverride) {
      args.push('-c', 'text.verbosity="medium"')
    }
    const { stdout } = await execCliWithInput({
      execFileImpl: execFileFn,
      cmd: binary,
      args,
      input: prompt,
      timeoutMs,
      env: effectiveEnv,
      cwd,
    })
    const { usage, costUsd } = parseCodexUsageFromJsonl(stdout)
    let fileText = ''
    try {
      fileText = (await fs.readFile(outputPath, 'utf8')).trim()
    } catch {
      fileText = ''
    }
    if (fileText) {
      return { text: fileText, usage, costUsd }
    }
    const stdoutText = stdout.trim()
    if (stdoutText) {
      return { text: stdoutText, usage, costUsd }
    }
    throw new Error('CLI returned empty output')
  }

  if (provider === 'agent') {
    args.push('--print', '--output-format', 'json')
    if (!allowTools) {
      args.push('--mode', 'ask')
    }
    if (model && model.trim().length > 0) {
      args.push('--model', model.trim())
    }
    args.push(prompt)
    const { stdout } = await execCliWithInput({
      execFileImpl: execFileFn,
      cmd: binary,
      args,
      input: '',
      timeoutMs,
      env: effectiveEnv,
      cwd,
    })
    const trimmed = stdout.trim()
    if (!trimmed) {
      throw new Error('CLI returned empty output')
    }
    const parsed = parseJsonFromOutput(trimmed)
    if (parsed && typeof parsed === 'object') {
      const payload = parsed as Record<string, unknown>
      const resultText =
        payload.result ??
        payload.response ??
        payload.output ??
        payload.message ??
        payload.text ??
        null
      if (typeof resultText === 'string' && resultText.trim().length > 0) {
        return { text: resultText.trim(), usage: null, costUsd: null }
      }
    }
    return { text: trimmed, usage: null, costUsd: null }
  }

  if (model && model.trim().length > 0) {
    args.push('--model', model.trim())
  }
  if (provider === 'claude') {
    args.push('--print')
  }
  args.push('--output-format', 'json')
  if (allowTools) {
    if (provider === 'claude') {
      args.push('--tools', 'Read', '--dangerously-skip-permissions')
    }
    if (provider === 'gemini') {
      args.push('--yolo')
    }
  }

  const { stdout } = await execCliWithInput({
    execFileImpl: execFileFn,
    cmd: binary,
    args,
    input: prompt,
    timeoutMs,
    env: effectiveEnv,
    cwd,
  })
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error('CLI returned empty output')
  }
  const parsed = parseJsonFromOutput(trimmed)
  if (parsed && typeof parsed === 'object') {
    const payload = parsed as Record<string, unknown>
    const resultText = payload.result ?? payload.response
    if (typeof resultText === 'string' && resultText.trim().length > 0) {
      const usage = provider === 'claude' ? parseClaudeUsage(payload) : parseGeminiUsage(payload)
      const costUsd = provider === 'claude' ? (toNumber(payload.total_cost_usd) ?? null) : null
      return { text: resultText.trim(), usage, costUsd }
    }
  }
  return { text: trimmed, usage: null, costUsd: null }
}

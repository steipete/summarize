import type { Command } from 'commander'
import { handleDaemonRequest } from '../daemon/cli.js'
import { refreshFree } from '../refresh-free.js'
import { handleTwitterRequest } from '../twitter/cli.js'
import { attachRichHelp, buildDaemonHelp, buildProgram, buildRefreshFreeHelp, buildTwitterHelp } from './help.js'

type HelpContext = {
  normalizedArgv: string[]
  envForRun: Record<string, string | undefined>
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export function handleHelpRequest({
  normalizedArgv,
  envForRun,
  stdout,
  stderr,
}: HelpContext): boolean {
  if (normalizedArgv[0]?.toLowerCase() !== 'help') return false
  const topic = normalizedArgv[1]?.toLowerCase()
  if (topic === 'refresh-free') {
    stdout.write(`${buildRefreshFreeHelp()}\n`)
    return true
  }
  if (topic === 'daemon') {
    stdout.write(`${buildDaemonHelp()}\n`)
    return true
  }
  if (topic === 'twitter') {
    stdout.write(`${buildTwitterHelp()}\n`)
    return true
  }

  const program: Command = buildProgram()
  program.configureOutput({
    writeOut(str) {
      stdout.write(str)
    },
    writeErr(str) {
      stderr.write(str)
    },
  })
  attachRichHelp(program, envForRun, stdout)
  program.outputHelp()
  return true
}

type RefreshContext = {
  normalizedArgv: string[]
  envForRun: Record<string, string | undefined>
  fetchImpl: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

export async function handleRefreshFreeRequest({
  normalizedArgv,
  envForRun,
  fetchImpl,
  stdout,
  stderr,
}: RefreshContext): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== 'refresh-free') return false

  const verbose = normalizedArgv.includes('--verbose') || normalizedArgv.includes('--debug')
  const setDefault = normalizedArgv.includes('--set-default')
  const help =
    normalizedArgv.includes('--help') ||
    normalizedArgv.includes('-h') ||
    normalizedArgv.includes('help')

  const readArgValue = (name: string): string | null => {
    const eq = normalizedArgv.find((a) => a.startsWith(`${name}=`))
    if (eq) return eq.slice(`${name}=`.length).trim() || null
    const index = normalizedArgv.indexOf(name)
    if (index === -1) return null
    const next = normalizedArgv[index + 1]
    if (!next || next.startsWith('-')) return null
    return next.trim() || null
  }

  const runsRaw = readArgValue('--runs')
  const smartRaw = readArgValue('--smart')
  const minParamsRaw = readArgValue('--min-params')
  const maxAgeDaysRaw = readArgValue('--max-age-days')
  const runs = runsRaw ? Number(runsRaw) : 2
  const smart = smartRaw ? Number(smartRaw) : 3
  const minParams = (() => {
    if (!minParamsRaw) return 27
    const raw = minParamsRaw.trim().toLowerCase()
    const normalized = raw.endsWith('b') ? raw.slice(0, -1).trim() : raw
    return Number(normalized)
  })()
  const maxAgeDays = (() => {
    if (!maxAgeDaysRaw) return 180
    return Number(maxAgeDaysRaw.trim())
  })()

  if (help) {
    stdout.write(`${buildRefreshFreeHelp()}\n`)
    return true
  }

  if (!Number.isFinite(runs) || runs < 0) throw new Error('--runs must be >= 0')
  if (!Number.isFinite(smart) || smart < 0) throw new Error('--smart must be >= 0')
  if (!Number.isFinite(minParams) || minParams < 0)
    throw new Error('--min-params must be >= 0 (e.g. 27b)')
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new Error('--max-age-days must be >= 0')

  await refreshFree({
    env: envForRun,
    fetchImpl,
    stdout,
    stderr,
    verbose,
    options: {
      runs,
      smart,
      minParamB: minParams,
      maxAgeDays,
      setDefault,
      maxCandidates: 10,
      concurrency: 4,
      timeoutMs: 10_000,
    },
  })
  return true
}

export async function handleDaemonCliRequest(ctx: RefreshContext): Promise<boolean> {
  return handleDaemonRequest({
    normalizedArgv: ctx.normalizedArgv,
    envForRun: ctx.envForRun,
    fetchImpl: ctx.fetchImpl,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  })
}

export async function handleTwitterCliRequest(ctx: RefreshContext): Promise<boolean> {
  return handleTwitterRequest({
    normalizedArgv: ctx.normalizedArgv,
    envForRun: ctx.envForRun,
    fetchImpl: ctx.fetchImpl,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  })
}

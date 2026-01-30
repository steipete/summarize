import fs from 'node:fs/promises'
import path from 'node:path'

import { buildDaemonHelp } from '../run/help.js'
import { readDaemonConfig, writeDaemonConfig } from './config.js'
import { DAEMON_HOST, DAEMON_PORT_DEFAULT } from './constants.js'
import { mergeDaemonEnv } from './env-merge.js'
import { buildEnvSnapshotFromEnv } from './env-snapshot.js'
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  restartLaunchAgent,
  uninstallLaunchAgent,
} from './launchd.js'
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  restartScheduledTask,
  uninstallScheduledTask,
} from './schtasks.js'
import { runDaemonServer } from './server.js'
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  restartSystemdService,
  uninstallSystemdService,
} from './systemd.js'

type DaemonCliContext = {
  normalizedArgv: string[]
  envForRun: Record<string, string | undefined>
  fetchImpl: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

function readArgValue(argv: string[], name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(`${name}=`.length).trim() || null
  const index = argv.indexOf(name)
  if (index === -1) return null
  const next = argv[index + 1]
  if (!next || next.startsWith('-')) return null
  return next.trim() || null
}

function wantHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h') || argv.includes('help')
}

function hasArg(argv: string[], name: string): boolean {
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`))
}

type DaemonServiceInstallArgs = {
  env: Record<string, string | undefined>
  stdout: NodeJS.WritableStream
  programArguments: string[]
  workingDirectory?: string
}

type DaemonService = {
  label: string
  loadedText: string
  notLoadedText: string
  install: (args: DaemonServiceInstallArgs) => Promise<void>
  uninstall: (args: {
    env: Record<string, string | undefined>
    stdout: NodeJS.WritableStream
  }) => Promise<void>
  restart: (args: { stdout: NodeJS.WritableStream }) => Promise<void>
  isLoaded: (args: { env: Record<string, string | undefined> }) => Promise<boolean>
}

function resolveDaemonService(): DaemonService {
  if (process.platform === 'darwin') {
    return {
      label: 'LaunchAgent',
      loadedText: 'loaded',
      notLoadedText: 'not loaded',
      install: async (args) => {
        await installLaunchAgent(args)
      },
      uninstall: async (args) => {
        await uninstallLaunchAgent(args)
      },
      restart: async (args) => {
        await restartLaunchAgent(args)
      },
      isLoaded: async () => isLaunchAgentLoaded(),
    }
  }

  if (process.platform === 'linux') {
    return {
      label: 'systemd',
      loadedText: 'enabled',
      notLoadedText: 'disabled',
      install: async (args) => {
        await installSystemdService(args)
      },
      uninstall: async (args) => {
        await uninstallSystemdService(args)
      },
      restart: async (args) => {
        await restartSystemdService(args)
      },
      isLoaded: async () => isSystemdServiceEnabled(),
    }
  }

  if (process.platform === 'win32') {
    return {
      label: 'Scheduled Task',
      loadedText: 'registered',
      notLoadedText: 'missing',
      install: async (args) => {
        await installScheduledTask(args)
      },
      uninstall: async (args) => {
        await uninstallScheduledTask(args)
      },
      restart: async (args) => {
        await restartScheduledTask(args)
      },
      isLoaded: async () => isScheduledTaskInstalled(),
    }
  }

  throw new Error(`Daemon service install not supported on ${process.platform}`)
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth({
  fetchImpl,
  port,
  timeoutMs,
}: {
  fetchImpl: typeof fetch
  port: number
  timeoutMs: number
}): Promise<void> {
  const url = `http://${DAEMON_HOST}:${port}/health`
  const startedAt = Date.now()
  // Simple polling; avoids bringing in extra deps.
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetchImpl(url, { method: 'GET' })
      if (res.ok) return
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Daemon not reachable at ${url}`)
}

async function waitForHealthWithRetries({
  fetchImpl,
  port,
  attempts,
  timeoutMs,
  delayMs,
}: {
  fetchImpl: typeof fetch
  port: number
  attempts: number
  timeoutMs: number
  delayMs: number
}): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await waitForHealth({ fetchImpl, port, timeoutMs })
      return
    } catch (err) {
      lastError = err
      if (attempt < attempts - 1) {
        const backoff = Math.round(delayMs * 1.6 ** attempt)
        await sleep(backoff)
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Daemon not reachable at ${DAEMON_HOST}:${port}`)
}

async function checkAuth({
  fetchImpl,
  token,
  port,
}: {
  fetchImpl: typeof fetch
  token: string
  port: number
}): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://${DAEMON_HOST}:${port}/v1/ping`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return res.ok
  } catch {
    return false
  }
}

async function checkAuthWithRetries({
  fetchImpl,
  token,
  port,
  attempts,
  delayMs,
}: {
  fetchImpl: typeof fetch
  token: string
  port: number
  attempts: number
  delayMs: number
}): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ok = await checkAuth({ fetchImpl, token, port })
    if (ok) return true
    if (attempt < attempts - 1) {
      const backoff = Math.round(delayMs * 1.4 ** attempt)
      await sleep(backoff)
    }
  }
  return false
}

async function resolveCliEntrypointPathForService(): Promise<string> {
  const argv1 = process.argv[1]
  if (!argv1) throw new Error('Unable to resolve CLI entrypoint path')

  // Resolve symlinks so that globally-installed bins (npm, bun, nvm, etc.)
  // point back to the real package directory instead of the symlink location.
  const normalized = await fs.realpath(path.resolve(argv1))
  const looksLikeDist = /[/\\]dist[/\\].+\.(cjs|js)$/.test(normalized)
  if (looksLikeDist) {
    await fs.access(normalized)
    return normalized
  }

  const distCandidates = [
    path.resolve(path.dirname(normalized), '../dist/cli.cjs'),
    path.resolve(path.dirname(normalized), '../dist/cli.js'),
  ]

  for (const candidate of distCandidates) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // keep going
    }
  }

  throw new Error(
    `Cannot find built CLI at ${distCandidates.join(' or ')}. Run "pnpm build:cli" (or "pnpm build") first, or pass --dev to install a dev daemon.`
  )
}

function resolveRepoRootForDev(): string {
  const argv1 = process.argv[1]
  if (!argv1) throw new Error('Unable to resolve repo root')
  const normalized = path.resolve(argv1)
  const parts = normalized.split(path.sep)
  const srcIndex = parts.lastIndexOf('src')
  if (srcIndex === -1) throw new Error('Dev mode requires running from repo (src/cli.ts)')
  return parts.slice(0, srcIndex).join(path.sep)
}

async function resolveTsxCliPath(repoRoot: string): Promise<string> {
  const candidate = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  await fs.access(candidate)
  return candidate
}

async function resolveDaemonProgramArguments({
  dev,
}: {
  dev: boolean
}): Promise<{ programArguments: string[]; workingDirectory?: string }> {
  const nodePath = process.execPath
  if (!dev) {
    try {
      const cliEntrypointPath = await resolveCliEntrypointPathForService()
      return {
        programArguments: [nodePath, cliEntrypointPath, 'daemon', 'run'],
        workingDirectory: undefined,
      }
    } catch (error) {
      const base = path.basename(nodePath).toLowerCase()
      const isNodeRuntime = base === 'node' || base === 'node.exe'
      if (!isNodeRuntime) {
        return {
          programArguments: [nodePath, 'daemon', 'run'],
          workingDirectory: undefined,
        }
      }
      throw error
    }
  }
  const repoRoot = resolveRepoRootForDev()
  const tsxCliPath = await resolveTsxCliPath(repoRoot)
  const devCliPath = path.join(repoRoot, 'src', 'cli.ts')
  await fs.access(devCliPath)
  return {
    programArguments: [nodePath, tsxCliPath, devCliPath, 'daemon', 'run'],
    workingDirectory: repoRoot,
  }
}

function formatProgramArguments(args: string[]): string {
  return args
    .map((arg) => {
      if (!/[\s"]/g.test(arg)) return arg
      return `"${arg.replace(/"/g, '\\"')}"`
    })
    .join(' ')
}

async function readInstalledDaemonCommand(
  env: Record<string, string | undefined>
): Promise<{ programArguments: string[]; workingDirectory?: string } | null> {
  if (process.platform === 'darwin') return readLaunchAgentProgramArguments(env)
  if (process.platform === 'linux') return readSystemdServiceExecStart(env)
  if (process.platform === 'win32') return readScheduledTaskCommand(env)
  return null
}

export async function handleDaemonRequest({
  normalizedArgv,
  envForRun,
  fetchImpl,
  stdout,
  stderr,
}: DaemonCliContext): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== 'daemon') return false

  const sub = normalizedArgv[1]?.toLowerCase() ?? null
  if (!sub || wantHelp(normalizedArgv)) {
    stdout.write(`${buildDaemonHelp()}\n`)
    return true
  }

  if (sub === 'install') {
    const service = resolveDaemonService()
    const token = readArgValue(normalizedArgv, '--token')
    if (!token) throw new Error('Missing --token')
    const portRaw = readArgValue(normalizedArgv, '--port')
    const port = portRaw ? Number(portRaw) : DAEMON_PORT_DEFAULT
    if (!Number.isFinite(port) || port <= 0 || port >= 65535) throw new Error('Invalid --port')
    const dev = hasArg(normalizedArgv, '--dev')

    const envSnapshot = buildEnvSnapshotFromEnv(envForRun)
    const configPath = await writeDaemonConfig({
      env: envForRun,
      config: { token, port, env: envSnapshot },
    })

    const { programArguments, workingDirectory } = await resolveDaemonProgramArguments({ dev })

    await service.install({ env: envForRun, stdout, programArguments, workingDirectory })
    await waitForHealthWithRetries({ fetchImpl, port, attempts: 5, timeoutMs: 5000, delayMs: 500 })
    const authed = await checkAuthWithRetries({
      fetchImpl,
      token: token.trim(),
      port,
      attempts: 5,
      delayMs: 400,
    })
    if (!authed) throw new Error('Daemon is up but auth failed (token mismatch?)')

    stdout.write(`Daemon config: ${configPath}\n`)
    const installedCommand = await readInstalledDaemonCommand(envForRun)
    if (installedCommand?.programArguments?.length) {
      stdout.write(`Daemon command: ${formatProgramArguments(installedCommand.programArguments)}\n`)
      if (installedCommand.workingDirectory) {
        stdout.write(`Daemon cwd: ${installedCommand.workingDirectory}\n`)
      }
    }
    stdout.write(`OK: daemon is running and authenticated.\n`)
    return true
  }

  if (sub === 'status') {
    const service = resolveDaemonService()
    const cfg = await readDaemonConfig({ env: envForRun })
    if (!cfg) {
      stdout.write('Daemon not installed (missing ~/.summarize/daemon.json)\n')
      stdout.write('Run: summarize daemon install --token <token>\n')
      return true
    }
    const loaded = await service.isLoaded({ env: envForRun })
    const healthy = await (async () => {
      try {
        await waitForHealth({ fetchImpl, port: cfg.port, timeoutMs: 1000 })
        return true
      } catch {
        return false
      }
    })()
    const authed = healthy
      ? await checkAuth({ fetchImpl, token: cfg.token, port: cfg.port })
      : false

    stdout.write(`${service.label}: ${loaded ? service.loadedText : service.notLoadedText}\n`)
    stdout.write(`Daemon: ${healthy ? `up on ${DAEMON_HOST}:${cfg.port}` : 'down'}\n`)
    stdout.write(`Auth: ${authed ? 'ok' : 'failed'}\n`)
    return true
  }

  if (sub === 'restart') {
    const service = resolveDaemonService()
    const cfg = await readDaemonConfig({ env: envForRun })
    if (!cfg) {
      stdout.write('Daemon not installed (missing ~/.summarize/daemon.json)\n')
      stdout.write('Run: summarize daemon install --token <token>\n')
      return true
    }
    const loaded = await service.isLoaded({ env: envForRun })
    if (!loaded) {
      stdout.write(
        `${service.label} ${service.notLoadedText}. Run: summarize daemon install --token <token>\n`
      )
      return true
    }

    await service.restart({ stdout })
    const installedCommand = await readInstalledDaemonCommand(envForRun)
    if (installedCommand?.programArguments?.length) {
      stdout.write(`Daemon command: ${formatProgramArguments(installedCommand.programArguments)}\n`)
      if (installedCommand.workingDirectory) {
        stdout.write(`Daemon cwd: ${installedCommand.workingDirectory}\n`)
      }
    }
    await sleep(8000)
    let healthy = true
    try {
      await waitForHealthWithRetries({
        fetchImpl,
        port: cfg.port,
        attempts: 3,
        timeoutMs: 15000,
        delayMs: 500,
      })
    } catch {
      healthy = false
    }
    const authed = healthy
      ? await checkAuthWithRetries({
          fetchImpl,
          token: cfg.token,
          port: cfg.port,
          attempts: 5,
          delayMs: 400,
        })
      : false
    if (!healthy || !authed) {
      stdout.write(
        'Restarted daemon. It is still starting; run "summarize daemon status" in a few seconds.\n'
      )
      return true
    }

    stdout.write('OK: daemon restarted and authenticated.\n')
    return true
  }

  if (sub === 'uninstall') {
    const service = resolveDaemonService()
    await service.uninstall({ env: envForRun, stdout })
    stdout.write(
      'Uninstalled (daemon autostart removed). Config left in ~/.summarize/daemon.json\n'
    )
    return true
  }

  if (sub === 'run') {
    const cfg = await readDaemonConfig({ env: envForRun })
    if (!cfg) {
      stderr.write('Missing ~/.summarize/daemon.json\n')
      stderr.write('Run: summarize daemon install --token <token>\n')
      throw new Error('Daemon not configured')
    }
    const mergedEnv = mergeDaemonEnv({ envForRun, snapshot: cfg.env })
    await runDaemonServer({ env: mergedEnv, fetchImpl, config: cfg })
    return true
  }

  stdout.write(`${buildDaemonHelp()}\n`)
  return true
}

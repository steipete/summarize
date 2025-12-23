import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCli } from './run.js'

export type CliMainArgs = {
  argv: string[]
  env: Record<string, string | undefined>
  fetch: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  exit: (code: number) => void
  setExitCode: (code: number) => void
}

export function handlePipeErrors(stream: NodeJS.WritableStream, exit: (code: number) => void) {
  stream.on('error', (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'EPIPE') {
      exit(0)
      return
    }
    throw error
  })
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    let line = trimmed
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()

    const equalsIndex = line.indexOf('=')
    if (equalsIndex <= 0) continue

    const key = line.slice(0, equalsIndex).trim()
    if (!key) continue

    let value = line.slice(equalsIndex + 1).trim()

    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
    } else {
      const commentIndex = value.search(/\s+#/)
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trimEnd()
    }

    out[key] = value
  }

  return out
}

async function loadDotenvFromCwd(): Promise<Record<string, string>> {
  const dotenvPath = join(process.cwd(), '.env')
  try {
    const text = await readFile(dotenvPath, 'utf8')
    return parseDotenv(text)
  } catch {
    return {}
  }
}

function stripAnsi(input: string): string {
  // Minimal, good-enough ANSI stripper for error output. We only use this for non-verbose errors.
  let out = ''

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (ch !== '\u001b') {
      out += ch
      continue
    }

    const next = input[i + 1]
    if (next === '[') {
      // CSI: ESC [ ... <final>
      i += 2
      while (i < input.length) {
        const c = input[i]
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) break
        i += 1
      }
      continue
    }

    if (next === ']') {
      // OSC: ESC ] ... (BEL | ESC \)
      i += 2
      while (i < input.length) {
        const c = input[i]
        if (c === '\u0007') break
        if (c === '\u001b' && input[i + 1] === '\\') {
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    // Unknown ESC sequence (or stray ESC): drop the next character too to avoid leaving artifacts.
    if (typeof next === 'string') {
      i += 1
    }
  }

  return out
}

export async function runCliMain({
  argv,
  env,
  fetch,
  stdout,
  stderr,
  exit,
  setExitCode,
}: CliMainArgs): Promise<void> {
  handlePipeErrors(stdout, exit)
  handlePipeErrors(stderr, exit)

  const verbose =
    argv.includes('--verbose') ||
    argv.includes('--verbose=true') ||
    argv.includes('--debug') ||
    argv.includes('--debug=true')

  try {
    const mergedEnv = env === process.env ? { ...(await loadDotenvFromCwd()), ...env } : env
    await runCli(argv, { env: mergedEnv, fetch, stdout, stderr })
  } catch (error: unknown) {
    const isTty = Boolean((stderr as unknown as { isTTY?: boolean }).isTTY)
    if (isTty) stderr.write('\n')

    if (verbose && error instanceof Error && typeof error.stack === 'string') {
      stderr.write(`${error.stack}\n`)
      const cause = (error as Error & { cause?: unknown }).cause
      if (cause instanceof Error && typeof cause.stack === 'string') {
        stderr.write(`Caused by: ${cause.stack}\n`)
      }
      setExitCode(1)
      return
    }

    const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error'
    stderr.write(`${stripAnsi(message)}\n`)
    setExitCode(1)
  }
}

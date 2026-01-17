import { CommanderError } from 'commander'

import { loadSummarizeConfig } from '../config.js'
import { parseDurationMs } from '../flags.js'
import {
  extractSlidesForSource,
  resolveSlideSettings,
  resolveSlideSourceFromUrl,
  type SlideExtractionResult,
} from '../slides/index.js'
import { startSpinner } from '../tty/spinner.js'
import { formatVersionLine } from '../version.js'
import { applyHelpStyle, buildSlidesProgram } from './help.js'
import { writeVerbose } from './logging.js'
import { resolveEnvState } from './run-env.js'
import { renderSlidesInline, type SlidesRenderMode } from './slides-render.js'
import { isRichTty, supportsColor } from './terminal.js'

type SlidesCliContext = {
  normalizedArgv: string[]
  envForRun: Record<string, string | undefined>
  fetchImpl: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const secs = clamped % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  if (hours <= 0) return `${minutes}:${ss}`
  const hh = String(hours).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function parseRenderMode(raw: unknown): SlidesRenderMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value || value === 'none') return 'none'
  if (value === 'auto' || value === 'kitty' || value === 'iterm') return value
  throw new Error(`Unsupported --render: ${String(raw)}`)
}

export async function handleSlidesCliRequest({
  normalizedArgv,
  envForRun,
  stdout,
  stderr,
}: SlidesCliContext): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== 'slides') return false

  const program = buildSlidesProgram()
  program.configureOutput({
    writeOut(str) {
      stdout.write(str)
    },
    writeErr(str) {
      stderr.write(str)
    },
  })
  applyHelpStyle(program, envForRun, stdout)
  program.exitOverride()

  try {
    program.parse(normalizedArgv.slice(1), { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') {
      return true
    }
    throw error
  }

  if (program.opts().version) {
    stdout.write(`${formatVersionLine()}\n`)
    return true
  }

  const url = program.args[0]
  if (!url) {
    throw new Error('summarize slides requires a URL input.')
  }

  const opts = program.opts() as {
    slidesOcr?: boolean
    slidesDir?: string
    output?: string
    slidesSceneThreshold?: string
    slidesMax?: string
    slidesMinDuration?: string
    render?: string
    timeout?: string
    cache?: boolean
    json?: boolean
    verbose?: boolean
    debug?: boolean
  }

  const renderMode = parseRenderMode(opts.render)
  if (opts.json && renderMode !== 'none') {
    throw new Error('--render is not supported with --json output.')
  }

  const slidesSettings = resolveSlideSettings({
    slides: true,
    slidesOcr: opts.slidesOcr ?? false,
    slidesDir: opts.output ?? opts.slidesDir,
    slidesSceneThreshold: opts.slidesSceneThreshold,
    slidesSceneThresholdExplicit: normalizedArgv.some(
      (arg) => arg === '--slides-scene-threshold' || arg.startsWith('--slides-scene-threshold=')
    ),
    slidesMax: opts.slidesMax,
    slidesMinDuration: opts.slidesMinDuration,
    cwd: process.cwd(),
  })
  if (!slidesSettings) {
    throw new Error('Slides are disabled (enable --slides-ocr or check arguments).')
  }

  const timeoutRaw = typeof opts.timeout === 'string' && opts.timeout.trim() ? opts.timeout : '2m'
  const timeoutMs = parseDurationMs(timeoutRaw)
  const { config } = loadSummarizeConfig({ env: envForRun })
  const envState = resolveEnvState({ env: envForRun, envForRun, configForCli: config })

  const source = resolveSlideSourceFromUrl(url)
  if (!source) {
    throw new Error('Slides are only supported for YouTube or direct video URLs.')
  }

  const verboseEnabled = Boolean(opts.verbose || opts.debug)
  const progressEnabled = isRichTty(stderr) && !opts.json && !verboseEnabled
  const spinner = startSpinner({
    text: 'Extracting slides…',
    enabled: progressEnabled,
    stream: stderr,
  })
  const verboseColor = supportsColor(stderr, envForRun)
  const logSlides = (message: string) => {
    writeVerbose(stderr, verboseEnabled, `slides ${message}`, verboseColor)
  }
  const onSlidesProgress = (text: string) => {
    if (progressEnabled) {
      spinner.setText(text)
      return
    }
    if (verboseEnabled) {
      stderr.write(`${text}\n`)
    }
  }

  let slidesExtracted: SlideExtractionResult
  try {
    slidesExtracted = await extractSlidesForSource({
      source,
      settings: slidesSettings,
      noCache: opts.cache === false,
      env: envForRun,
      timeoutMs,
      ytDlpPath: envState.ytDlpPath,
      ffmpegPath: null,
      tesseractPath: null,
      hooks: {
        onSlidesProgress,
        onSlidesLog: logSlides,
      },
    })
  } finally {
    spinner.stopAndClear()
  }

  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: true, slides: slidesExtracted }, null, 2)}\n`)
    return true
  }

  const count = slidesExtracted.slides.length
  stdout.write(`Slides extracted: ${count}\n`)
  stdout.write(`Slides dir: ${slidesExtracted.slidesDir}\n`)

  if (renderMode !== 'none') {
    if (!isRichTty(stdout)) {
      throw new Error('--render requires a TTY stdout.')
    }
    await renderSlidesInline({
      slides: slidesExtracted.slides,
      mode: renderMode,
      env: envForRun,
      stdout,
      labelForSlide: (slide) =>
        `Slide ${slide.index} · ${formatTimestamp(slide.timestamp)} (${slide.imagePath})`,
    })
    return true
  }

  for (const slide of slidesExtracted.slides) {
    stdout.write(`${slide.index}\t${formatTimestamp(slide.timestamp)}\t${slide.imagePath}\n`)
  }
  return true
}

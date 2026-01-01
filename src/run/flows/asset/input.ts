import fs from 'node:fs/promises'
import { render as renderMarkdownAnsi } from 'markdansi'
import {
  classifyUrl,
  type InputTarget,
  loadLocalAsset,
  loadRemoteAsset,
} from '../../../content/asset.js'
import type { RunMetricsReport } from '../../../costs.js'
import type { ExecFileFn } from '../../../markitdown.js'
import { formatBytes } from '../../../tty/format.js'
import { startOscProgress } from '../../../tty/osc-progress.js'
import { startSpinner } from '../../../tty/spinner.js'
import { assertAssetMediaTypeSupported } from '../../attachments.js'
import { buildExtractFinishLabel, writeFinishLine } from '../../finish-line.js'
import { prepareMarkdownForTerminal } from '../../markdown.js'
import { isRichTty, markdownRenderWidth, supportsColor } from '../../terminal.js'
import { extractAssetContent } from './extract.js'
import type { SummarizeAssetArgs } from './summary.js'

export type AssetInputContext = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  progressEnabled: boolean
  timeoutMs: number
  trackedFetch: typeof fetch
  execFileImpl: ExecFileFn
  preprocessMode: 'off' | 'auto' | 'always'
  format: 'text' | 'markdown'
  extractMode: boolean
  plain: boolean
  json: boolean
  metricsEnabled: boolean
  metricsDetailed: boolean
  shouldComputeReport: boolean
  runStartedAtMs: number
  verboseColor: boolean
  buildReport: () => Promise<RunMetricsReport>
  estimateCostUsd: () => Promise<number | null>
  apiStatus: {
    xaiApiKey: string | null
    apiKey: string | null
    openrouterApiKey: string | null
    apifyToken: string | null
    firecrawlConfigured: boolean
    googleConfigured: boolean
    anthropicConfigured: boolean
  }
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<void>
  setClearProgressBeforeStdout: (fn: (() => void) | null) => void
  clearProgressIfCurrent: (fn: () => void) => void
}

export async function handleFileInput(
  ctx: AssetInputContext,
  inputTarget: InputTarget
): Promise<boolean> {
  if (inputTarget.kind !== 'file') return false

  let sizeLabel: string | null = null
  try {
    const stat = await fs.stat(inputTarget.filePath)
    if (stat.isFile()) {
      sizeLabel = formatBytes(stat.size)
    }
  } catch {
    // Ignore size preflight; loadLocalAsset will throw a user-friendly error if needed.
  }

  const stopOscProgress = startOscProgress({
    label: 'Loading file',
    indeterminate: true,
    env: ctx.env,
    isTty: ctx.progressEnabled,
    write: (data: string) => ctx.stderr.write(data),
  })
  const spinner = startSpinner({
    text: sizeLabel ? `Loading file (${sizeLabel})…` : 'Loading file…',
    enabled: ctx.progressEnabled,
    stream: ctx.stderr,
  })
  let stopped = false
  const stopProgress = () => {
    if (stopped) return
    stopped = true
    spinner.stopAndClear()
    stopOscProgress()
  }
  const clearProgressLine = () => {
    stopProgress()
  }
  ctx.setClearProgressBeforeStdout(clearProgressLine)
  try {
    const loaded = await loadLocalAsset({ filePath: inputTarget.filePath })
    assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel })
    if (ctx.progressEnabled) {
      const mt = loaded.attachment.mediaType
      const name = loaded.attachment.filename
      const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt
      spinner.setText(name ? `Summarizing ${name} (${details})…` : `Summarizing ${details}…`)
    }
    await ctx.summarizeAsset({
      sourceKind: 'file',
      sourceLabel: loaded.sourceLabel,
      attachment: loaded.attachment,
      onModelChosen: (modelId) => {
        if (!ctx.progressEnabled) return
        const mt = loaded.attachment.mediaType
        const name = loaded.attachment.filename
        const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt
        spinner.setText(
          name
            ? `Summarizing ${name} (${details}, model: ${modelId})…`
            : `Summarizing ${details} (model: ${modelId})…`
        )
      },
    })
    return true
  } finally {
    ctx.clearProgressIfCurrent(clearProgressLine)
    stopProgress()
  }
}

export async function handleUrlAsset(
  ctx: AssetInputContext,
  url: string,
  isYoutubeUrl: boolean
): Promise<boolean> {
  if (!url || isYoutubeUrl) return false

  const kind = await classifyUrl({ url, fetchImpl: ctx.trackedFetch, timeoutMs: ctx.timeoutMs })
  if (kind.kind !== 'asset') return false

  const stopOscProgress = startOscProgress({
    label: 'Downloading file',
    indeterminate: true,
    env: ctx.env,
    isTty: ctx.progressEnabled,
    write: (data: string) => ctx.stderr.write(data),
  })
  const spinner = startSpinner({
    text: 'Downloading file…',
    enabled: ctx.progressEnabled,
    stream: ctx.stderr,
  })
  let stopped = false
  const stopProgress = () => {
    if (stopped) return
    stopped = true
    spinner.stopAndClear()
    stopOscProgress()
  }
  const clearProgressLine = () => {
    stopProgress()
  }
  ctx.setClearProgressBeforeStdout(clearProgressLine)
  try {
    const loaded = await (async () => {
      try {
        return await loadRemoteAsset({ url, fetchImpl: ctx.trackedFetch, timeoutMs: ctx.timeoutMs })
      } catch (error) {
        if (error instanceof Error && /HTML/i.test(error.message)) {
          return null
        }
        throw error
      }
    })()

    if (!loaded) return false
    assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel: null })
    if (ctx.extractMode) {
      if (ctx.progressEnabled) spinner.setText('Extracting text…')
      const extracted = await extractAssetContent({
        ctx: {
          env: ctx.env,
          envForRun: ctx.envForRun,
          execFileImpl: ctx.execFileImpl,
          timeoutMs: ctx.timeoutMs,
          preprocessMode: ctx.preprocessMode,
          format: ctx.format,
        },
        attachment: loaded.attachment,
      })

      clearProgressLine()

      if (ctx.json) {
        const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null
        const payload = {
          input: {
            kind: 'asset-url' as const,
            url,
            timeoutMs: ctx.timeoutMs,
            format: ctx.format,
            preprocess: ctx.preprocessMode,
          },
          env: {
            hasXaiKey: Boolean(ctx.apiStatus.xaiApiKey),
            hasOpenAIKey: Boolean(ctx.apiStatus.apiKey),
            hasOpenRouterKey: Boolean(ctx.apiStatus.openrouterApiKey),
            hasApifyToken: Boolean(ctx.apiStatus.apifyToken),
            hasFirecrawlKey: ctx.apiStatus.firecrawlConfigured,
            hasGoogleKey: ctx.apiStatus.googleConfigured,
            hasAnthropicKey: ctx.apiStatus.anthropicConfigured,
          },
          extracted: {
            kind: 'asset' as const,
            source: loaded.sourceLabel,
            mediaType: loaded.attachment.mediaType,
            filename: loaded.attachment.filename,
            content: extracted.content,
          },
          prompt: null,
          llm: null,
          metrics: ctx.metricsEnabled ? finishReport : null,
          summary: null,
        }
        ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        if (ctx.metricsEnabled && finishReport) {
          const costUsd = await ctx.estimateCostUsd()
          const finishLabel = buildExtractFinishLabel({
            extracted: { diagnostics: extracted.diagnostics },
            format: extracted.format,
            markdownMode: 'off',
            hasMarkdownLlmCall: false,
          })
          writeFinishLine({
            stderr: ctx.stderr,
            elapsedMs: Date.now() - ctx.runStartedAtMs,
            label: finishLabel,
            model: null,
            report: finishReport,
            costUsd,
            detailed: ctx.metricsDetailed,
            extraParts: null,
            color: ctx.verboseColor,
          })
        }
      } else {
        const rendered =
          extracted.format === 'markdown' && !ctx.plain && isRichTty(ctx.stdout)
            ? renderMarkdownAnsi(prepareMarkdownForTerminal(extracted.content), {
                width: markdownRenderWidth(ctx.stdout, ctx.env),
                wrap: true,
                color: supportsColor(ctx.stdout, ctx.envForRun),
                hyperlinks: true,
              })
            : extracted.content
        ctx.stdout.write(rendered)
        if (!rendered.endsWith('\n')) {
          ctx.stdout.write('\n')
        }
        if (ctx.metricsEnabled) {
          const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null
          if (finishReport) {
            const costUsd = await ctx.estimateCostUsd()
            const finishLabel = buildExtractFinishLabel({
              extracted: { diagnostics: extracted.diagnostics },
              format: extracted.format,
              markdownMode: 'off',
              hasMarkdownLlmCall: false,
            })
            writeFinishLine({
              stderr: ctx.stderr,
              elapsedMs: Date.now() - ctx.runStartedAtMs,
              label: finishLabel,
              model: null,
              report: finishReport,
              costUsd,
              detailed: ctx.metricsDetailed,
              extraParts: null,
              color: ctx.verboseColor,
            })
          }
        }
      }
      return true
    }

    if (ctx.progressEnabled) spinner.setText('Summarizing…')
    await ctx.summarizeAsset({
      sourceKind: 'asset-url',
      sourceLabel: loaded.sourceLabel,
      attachment: loaded.attachment,
      onModelChosen: (modelId) => {
        if (!ctx.progressEnabled) return
        spinner.setText(`Summarizing (model: ${modelId})…`)
      },
    })
    return true
  } finally {
    ctx.clearProgressIfCurrent(clearProgressLine)
    stopProgress()
  }
}

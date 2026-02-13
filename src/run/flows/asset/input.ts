import fs from 'node:fs/promises'
import path from 'node:path'
import { isDirectMediaExtension, isDirectMediaUrl } from '@steipete/summarize-core/content/url'
import {
  classifyUrl,
  type InputTarget,
  loadLocalAsset,
  loadRemoteAsset,
} from '../../../content/asset.js'
import { formatBytes } from '../../../tty/format.js'
import { startOscProgress } from '../../../tty/osc-progress.js'
import { startSpinner } from '../../../tty/spinner.js'
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from '../../../tty/theme.js'
import { assertAssetMediaTypeSupported } from '../../attachments.js'
import type { SummarizeAssetArgs } from './summary.js'

/**
 * Check if a media type should route through transcription.
 */
function isTranscribableMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase()
  return normalized.startsWith('audio/') || normalized.startsWith('video/')
}

const createProgressTheme = (
  envForRun: Record<string, string | undefined> | undefined,
  enabled: boolean
) => {
  const env = envForRun ?? {}
  return createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: env.SUMMARIZE_THEME }),
    enabled,
    trueColor: resolveTrueColor(env),
  })
}

const renderStatus = (theme: ReturnType<typeof createProgressTheme>, label: string, detail = '…') =>
  `${theme.label(label)}${theme.dim(detail)}`

const renderStatusWithMeta = (
  theme: ReturnType<typeof createProgressTheme>,
  label: string,
  meta: string,
  suffix = '…'
) => `${theme.label(label)} ${meta}${theme.dim(suffix)}`

const renderModelSuffix = (theme: ReturnType<typeof createProgressTheme>, modelId: string) =>
  `${theme.dim(' (model: ')}${theme.accent(modelId)}${theme.dim(')')}`

function normalizePathForExtension(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return value.split(/[?#]/, 1)[0]
  }
}

/**
 * Check if a file extension indicates transcribable media.
 * Used to route large audio/video files directly to the media handler
 * which has a higher size limit (2GB vs 50MB).
 */
export function isTranscribableExtension(filePath: string): boolean {
  if (isDirectMediaUrl(filePath)) return true
  const ext = path.extname(normalizePathForExtension(filePath))
  return isDirectMediaExtension(ext)
}

function formatTranscriptionMeta({
  filename,
  sizeLabel,
  dim,
}: {
  filename: string
  sizeLabel: string | null
  dim: (value: string) => string
}): string {
  const details = sizeLabel ? `${sizeLabel}` : ''
  return details ? `${filename} ${dim('(')}${details}${dim(')')}` : filename
}

function setTranscribingSpinnerText({
  spinner,
  theme,
  meta,
  modelId,
}: {
  spinner: ReturnType<typeof startSpinner>
  theme: ReturnType<typeof createProgressTheme>
  meta: string
  modelId?: string
}) {
  const modelLabel = modelId ? renderModelSuffix(theme, modelId) : ''
  spinner.setText(renderStatusWithMeta(theme, 'Transcribing', `${meta}${modelLabel}`))
}

async function runMediaTranscription({
  ctx,
  sourceKind,
  sourceLabel,
  filename,
  sizeLabel,
  spinner,
}: {
  ctx: AssetInputContext
  sourceKind: 'file' | 'asset-url'
  sourceLabel: string
  filename: string
  sizeLabel: string | null
  spinner: ReturnType<typeof startSpinner>
}): Promise<void> {
  const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled)
  const dim = (value: string) => theme.dim(value)
  const meta = formatTranscriptionMeta({ filename, sizeLabel, dim })

  if (ctx.progressEnabled) {
    setTranscribingSpinnerText({ spinner, theme, meta })
  }

  await ctx.summarizeMediaFile?.({
    sourceKind,
    sourceLabel,
    attachment: {
      kind: 'file',
      filename,
      mediaType: 'audio/mpeg', // Will be detected properly by summarizeMediaFile
      bytes: new Uint8Array(0), // Placeholder - summarizeMediaFile reads from path directly
    },
    onModelChosen: (modelId) => {
      if (!ctx.progressEnabled) return
      setTranscribingSpinnerText({ spinner, theme, meta, modelId })
    },
  })
}

export type AssetInputContext = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  stderr: NodeJS.WritableStream
  progressEnabled: boolean
  timeoutMs: number
  trackedFetch: typeof fetch
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<void>
  summarizeMediaFile?: (args: SummarizeAssetArgs) => Promise<void>
  setClearProgressBeforeStdout: (fn: (() => undefined | (() => void)) | null) => void
  clearProgressIfCurrent: (fn: () => void) => void
}

type UrlAssetHandler = (args: {
  loaded: Awaited<ReturnType<typeof loadRemoteAsset>>
  spinner: ReturnType<typeof startSpinner>
  clearProgressLine: () => void
}) => Promise<void>

export async function handleFileInput(
  ctx: AssetInputContext,
  inputTarget: InputTarget
): Promise<boolean> {
  if (inputTarget.kind !== 'file') return false

  let sizeLabel: string | null = null
  const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled)
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
    text: renderStatus(theme, 'Loading file', sizeLabel ? ` (${sizeLabel})…` : '…'),
    enabled: ctx.progressEnabled,
    stream: ctx.stderr,
    color: theme.palette.spinner,
  })
  let stopped = false
  const stopProgress = () => {
    if (stopped) return
    stopped = true
    spinner.stopAndClear()
    stopOscProgress()
  }
  const pauseProgressLine = () => {
    spinner.pause()
    return () => spinner.resume()
  }
  ctx.setClearProgressBeforeStdout(pauseProgressLine)
  try {
    // Check if file looks like transcribable media by extension.
    // If so, route directly to summarizeMediaFile which has a higher size limit (2GB).
    // This avoids the 50MB limit in loadLocalAsset for audio/video files.
    if (isTranscribableExtension(inputTarget.filePath) && ctx.summarizeMediaFile) {
      const filename = path.basename(inputTarget.filePath)
      await runMediaTranscription({
        ctx,
        sourceKind: 'file',
        sourceLabel: inputTarget.filePath,
        filename,
        sizeLabel,
        spinner,
      })
      return true
    }

    const loaded = await loadLocalAsset({ filePath: inputTarget.filePath })
    assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel })

    const isTranscribable = isTranscribableMediaType(loaded.attachment.mediaType)
    const handler =
      isTranscribable && ctx.summarizeMediaFile ? ctx.summarizeMediaFile : ctx.summarizeAsset

    const dim = (value: string) => theme.dim(value)

    if (ctx.progressEnabled) {
      const mt = loaded.attachment.mediaType
      const name = loaded.attachment.filename
      const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt
      const action = isTranscribable ? 'Transcribing' : 'Summarizing'
      const meta = name ? `${name} ${dim('(')}${details}${dim(')')}` : details
      spinner.setText(renderStatusWithMeta(theme, action, meta))
    }

    await handler({
      sourceKind: 'file',
      sourceLabel: loaded.sourceLabel,
      attachment: loaded.attachment,
      onModelChosen: (modelId) => {
        if (!ctx.progressEnabled) return
        const mt = loaded.attachment.mediaType
        const name = loaded.attachment.filename
        const details = sizeLabel ? `${mt}, ${sizeLabel}` : mt
        const meta = name ? `${name} ${dim('(')}${details}${dim(')')}` : details
        const modelLabel = renderModelSuffix(theme, modelId)
        spinner.setText(renderStatusWithMeta(theme, 'Summarizing', `${meta}${modelLabel}`))
      },
    })
    return true
  } finally {
    ctx.clearProgressIfCurrent(pauseProgressLine)
    stopProgress()
  }
}

export async function withUrlAsset(
  ctx: AssetInputContext,
  url: string,
  isYoutubeUrl: boolean,
  handler: UrlAssetHandler
): Promise<boolean> {
  if (!url || isYoutubeUrl) return false

  // For remote media URLs (by extension), route directly to summarizeMediaFile.
  // This avoids the 50MB limit in loadRemoteAsset - yt-dlp handles streaming download.
  if (isTranscribableExtension(url) && ctx.summarizeMediaFile) {
    const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled)
    const filename = (() => {
      try {
        return path.basename(new URL(url).pathname) || 'media'
      } catch {
        return 'media'
      }
    })()
    const stopOscProgress = startOscProgress({
      label: 'Transcribing media',
      indeterminate: true,
      env: ctx.env,
      isTty: ctx.progressEnabled,
      write: (data: string) => ctx.stderr.write(data),
    })
    const spinner = startSpinner({
      text: renderStatusWithMeta(theme, 'Transcribing', filename),
      enabled: ctx.progressEnabled,
      stream: ctx.stderr,
      color: theme.palette.spinner,
    })
    let stopped = false
    const stopProgress = () => {
      if (stopped) return
      stopped = true
      spinner.stopAndClear()
      stopOscProgress()
    }
    const pauseProgressLine = () => {
      spinner.pause()
      return () => spinner.resume()
    }
    ctx.setClearProgressBeforeStdout(pauseProgressLine)
    try {
      await runMediaTranscription({
        ctx,
        sourceKind: 'asset-url',
        sourceLabel: url,
        filename,
        sizeLabel: null,
        spinner,
      })
      return true
    } finally {
      ctx.clearProgressIfCurrent(pauseProgressLine)
      stopProgress()
    }
  }

  const kind = await classifyUrl({ url, fetchImpl: ctx.trackedFetch, timeoutMs: ctx.timeoutMs })
  if (kind.kind !== 'asset') return false

  const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled)
  const stopOscProgress = startOscProgress({
    label: 'Downloading file',
    indeterminate: true,
    env: ctx.env,
    isTty: ctx.progressEnabled,
    write: (data: string) => ctx.stderr.write(data),
  })
  const spinner = startSpinner({
    text: renderStatus(theme, 'Downloading file'),
    enabled: ctx.progressEnabled,
    stream: ctx.stderr,
    color: theme.palette.spinner,
  })
  let stopped = false
  const stopProgress = () => {
    if (stopped) return
    stopped = true
    spinner.stopAndClear()
    stopOscProgress()
  }
  const pauseProgressLine = () => {
    spinner.pause()
    return () => spinner.resume()
  }
  ctx.setClearProgressBeforeStdout(pauseProgressLine)
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
    await handler({ loaded, spinner, clearProgressLine: pauseProgressLine })
    return true
  } finally {
    ctx.clearProgressIfCurrent(pauseProgressLine)
    stopProgress()
  }
}

export async function handleUrlAsset(
  ctx: AssetInputContext,
  url: string,
  isYoutubeUrl: boolean
): Promise<boolean> {
  // Media URL handling is now in withUrlAsset
  return withUrlAsset(ctx, url, isYoutubeUrl, async ({ loaded, spinner }) => {
    const theme = createProgressTheme(ctx.envForRun, ctx.progressEnabled)
    const dim = (value: string) => theme.dim(value)
    if (ctx.progressEnabled) {
      spinner.setText(renderStatusWithMeta(theme, 'Summarizing', dim('file')))
    }
    await ctx.summarizeAsset({
      sourceKind: 'asset-url',
      sourceLabel: loaded.sourceLabel,
      attachment: loaded.attachment,
      onModelChosen: (modelId) => {
        if (!ctx.progressEnabled) return
        const modelLabel = renderModelSuffix(theme, modelId)
        spinner.setText(renderStatusWithMeta(theme, 'Summarizing', `${dim('file')}${modelLabel}`))
      },
    })
  })
}

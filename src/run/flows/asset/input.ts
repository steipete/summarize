import fs from 'node:fs/promises'
import {
  classifyUrl,
  type InputTarget,
  loadLocalAsset,
  loadRemoteAsset,
} from '../../../content/asset.js'
import { formatBytes } from '../../../tty/format.js'
import { startOscProgress } from '../../../tty/osc-progress.js'
import { startSpinner } from '../../../tty/spinner.js'
import { assertAssetMediaTypeSupported } from '../../attachments.js'
import type { SummarizeAssetArgs } from './summary.js'

export type AssetInputContext = {
  env: Record<string, string | undefined>
  stderr: NodeJS.WritableStream
  progressEnabled: boolean
  timeoutMs: number
  trackedFetch: typeof fetch
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
    spinner.pause()
    queueMicrotask(() => spinner.resume())
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
    spinner.pause()
    queueMicrotask(() => spinner.resume())
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

    if (!loaded) return true
    assertAssetMediaTypeSupported({ attachment: loaded.attachment, sizeLabel: null })
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

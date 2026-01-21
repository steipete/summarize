import { promises as fs } from 'node:fs'
import { createMarkdownStreamer, render as renderMarkdownAnsi } from 'markdansi'

import type { ExtractedLinkContent } from '../../../content/index.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import type { SlideExtractionResult, SlideImage, SlideSourceKind } from '../../../slides/index.js'
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from '../../../tty/theme.js'
import { prepareMarkdownForTerminalStreaming } from '../../markdown.js'
import { createSlidesInlineRenderer } from '../../slides-render.js'
import { createStreamOutputGate, type StreamOutputMode } from '../../stream-output.js'
import type { SummaryStreamHandler } from '../../summary-engine.js'
import { isRichTty, markdownRenderWidth, supportsColor } from '../../terminal.js'
import {
  buildTimestampUrl,
  formatOsc8Link,
  formatTimestamp,
  type SlideTimelineEntry,
  splitSlideTitleFromText,
} from './slides-text.js'

type SlideState = SlideTimelineEntry & { imagePath: string | null }

function createSlideOutputState(initialSlides: SlideExtractionResult | null | undefined) {
  const slidesByIndex = new Map<number, SlideState>()
  const pending = new Map<number, Array<(value: SlideState | null) => void>>()
  let order: number[] = []
  let slidesDir = initialSlides?.slidesDir ?? ''
  let sourceUrl = initialSlides?.sourceUrl ?? ''
  let done = false

  const updateSlideEntry = (slide: SlideImage) => {
    const existing = slidesByIndex.get(slide.index)
    const next: SlideState = {
      index: slide.index,
      timestamp:
        Number.isFinite(slide.timestamp) && slide.timestamp >= 0
          ? slide.timestamp
          : (existing?.timestamp ?? 0),
      imagePath: slide.imagePath ? slide.imagePath : (existing?.imagePath ?? null),
    }
    slidesByIndex.set(slide.index, next)
    if (slide.imagePath) {
      const waiters = pending.get(slide.index)
      if (waiters && waiters.length > 0) {
        pending.delete(slide.index)
        for (const resolve of waiters) {
          resolve(next)
        }
      }
    }
  }

  const setMeta = (meta: { slidesDir?: string | null; sourceUrl?: string | null }) => {
    if (meta.slidesDir) slidesDir = meta.slidesDir
    if (meta.sourceUrl) sourceUrl = meta.sourceUrl
  }

  const updateFromSlides = (slides: SlideExtractionResult) => {
    slidesDir = slides.slidesDir
    sourceUrl = slides.sourceUrl
    const ordered = slides.slides
      .filter((slide) => Number.isFinite(slide.timestamp))
      .map((slide) => ({ index: slide.index, timestamp: slide.timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp)
    order = ordered.map((slide) => slide.index)
    for (const slide of slides.slides) {
      updateSlideEntry(slide)
    }
  }

  if (initialSlides) updateFromSlides(initialSlides)

  const markDone = () => {
    if (done) return
    done = true
    for (const [index, waiters] of pending.entries()) {
      const entry = slidesByIndex.get(index) ?? null
      for (const resolve of waiters) {
        resolve(entry)
      }
    }
    pending.clear()
  }

  const waitForSlide = (index: number): Promise<SlideState | null> => {
    const existing = slidesByIndex.get(index)
    if (existing?.imagePath) return Promise.resolve(existing)
    if (done) return Promise.resolve(existing ?? null)
    return new Promise((resolve) => {
      const list = pending.get(index) ?? []
      list.push(resolve)
      pending.set(index, list)
    })
  }

  return {
    setMeta,
    updateFromSlides,
    updateSlideEntry,
    waitForSlide,
    markDone,
    getSlides: () => order.map((index) => slidesByIndex.get(index)).filter(Boolean) as SlideState[],
    getSlide: (index: number) => slidesByIndex.get(index) ?? null,
    getOrder: () => order.slice(),
    getSlidesDir: () => slidesDir,
    getSourceUrl: () => sourceUrl,
    isDone: () => done,
  }
}

export type SlidesTerminalOutput = {
  onSlidesExtracted: (slides: SlideExtractionResult) => void
  onSlidesDone: (result: { ok: boolean; error?: string | null }) => void
  onSlideChunk: (chunk: {
    slide: SlideImage
    meta: {
      slidesDir: string
      sourceUrl: string
      sourceId: string
      sourceKind: SlideSourceKind
      ocrAvailable: boolean
    }
  }) => void
  streamHandler: SummaryStreamHandler
  renderFromText: (summary: string) => Promise<void>
}

export function createSlidesTerminalOutput({
  io,
  flags,
  extracted,
  slides,
  enabled,
  outputMode,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  onProgressText,
}: {
  io: {
    env: Record<string, string | undefined>
    envForRun: Record<string, string | undefined>
    stdout: NodeJS.WritableStream
    stderr: NodeJS.WritableStream
  }
  flags: {
    plain: boolean
    lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
    slidesDebug?: boolean
  }
  extracted: ExtractedLinkContent
  slides: SlideExtractionResult | null | undefined
  enabled: boolean
  outputMode?: StreamOutputMode | null
  clearProgressForStdout: () => void
  restoreProgressAfterStdout?: (() => void) | null
  onProgressText?: ((text: string) => void) | null
}): SlidesTerminalOutput | null {
  if (!enabled) return null
  const inlineRenderer = !flags.plain
    ? createSlidesInlineRenderer({ mode: 'auto', env: io.envForRun, stdout: io.stdout })
    : null
  const inlineProtocol = inlineRenderer?.protocol ?? 'none'
  const inlineEnabled = inlineProtocol !== 'none'
  const inlineNoticeEnabled = !flags.plain && !inlineEnabled
  let inlineNoticeShown = false
  const labelTheme = createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: io.envForRun.SUMMARIZE_THEME }),
    enabled: supportsColor(io.stdout, io.envForRun) && !flags.plain,
    trueColor: resolveTrueColor(io.envForRun),
  })

  const state = createSlideOutputState(slides)
  state.setMeta({ sourceUrl: extracted.url })
  const noteInlineUnsupported = (nextSlides: SlideExtractionResult) => {
    if (!inlineNoticeEnabled || inlineNoticeShown) return
    if (!nextSlides.slidesDir) return
    inlineNoticeShown = true
    const reason = isRichTty(io.stdout)
      ? 'terminal does not support inline images'
      : 'stdout is not a TTY'
    clearProgressForStdout()
    io.stderr.write(
      `Slides saved to ${nextSlides.slidesDir}. Inline images unavailable (${reason}).\n`
    )
    const urlArg = JSON.stringify(nextSlides.sourceUrl)
    const dirArg = JSON.stringify(nextSlides.slidesDir)
    io.stderr.write(`Use summarize slides ${urlArg} --output ${dirArg} to export only.\n`)
    restoreProgressAfterStdout?.()
  }

  const onSlidesExtracted = (nextSlides: SlideExtractionResult) => {
    state.updateFromSlides(nextSlides)
    noteInlineUnsupported(nextSlides)
  }

  const onSlideChunk = (chunk: {
    slide: SlideImage
    meta: { slidesDir: string; sourceUrl: string }
  }) => {
    state.setMeta({ slidesDir: chunk.meta?.slidesDir, sourceUrl: chunk.meta?.sourceUrl })
    state.updateSlideEntry(chunk.slide)
  }

  const onSlidesDone = (_result: { ok: boolean; error?: string | null }) => {
    state.markDone()
  }

  let renderedCount = 0
  const renderSlide = async (index: number, title?: string | null) => {
    if (index <= 0) return
    const total = state.getOrder().length || (slides?.slides.length ?? 0)
    const slide = state.getSlide(index)
    let imagePath = slide?.imagePath ?? null
    if (inlineEnabled) {
      const ready = await state.waitForSlide(index)
      imagePath = ready?.imagePath ?? imagePath
    }
    const timestamp = slide?.timestamp
    const timestampLabel =
      typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? formatTimestamp(timestamp)
        : null
    const timestampUrl =
      typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? buildTimestampUrl(state.getSourceUrl(), timestamp)
        : null
    const timeLink = timestampLabel
      ? formatOsc8Link(timestampLabel, timestampUrl, isRichTty(io.stdout) && !flags.plain)
      : null
    const slideLabelBase = total > 0 ? `Slide ${index}/${total}` : `Slide ${index}`
    const rawLabel = [slideLabelBase, timeLink].filter(Boolean).join(' · ')
    const label = labelTheme.dim(rawLabel)
    const cleanTitle = title?.replace(/\s+/g, ' ').trim() ?? ''
    const titleMax = 90
    const shortTitle =
      cleanTitle.length > titleMax
        ? `${cleanTitle.slice(0, titleMax - 3).trimEnd()}...`
        : cleanTitle
    const titleLine = shortTitle ? labelTheme.heading(shortTitle) : ''
    const headerLine = shortTitle
      ? `${titleLine}${timeLink ? ` ${labelTheme.dim(`· ${timeLink}`)}` : ''}`
      : label

    clearProgressForStdout()
    io.stdout.write('\n')
    if (inlineEnabled && imagePath && inlineRenderer && !flags.slidesDebug) {
      await inlineRenderer.renderSlide({ index, timestamp: timestamp ?? 0, imagePath }, null)
    }
    if (flags.slidesDebug) {
      let resolvedPath = imagePath ?? '(missing image path)'
      if (imagePath) {
        const exists = await fs
          .stat(imagePath)
          .then(() => true)
          .catch(() => false)
        resolvedPath = exists ? imagePath : `${imagePath} (missing)`
      }
      io.stdout.write(`${headerLine}\n${resolvedPath}\n\n`)
    } else {
      io.stdout.write(`${headerLine}\n\n`)
    }
    restoreProgressAfterStdout?.()

    if (onProgressText && total > 0) {
      renderedCount = Math.min(total, renderedCount + 1)
      onProgressText(`Slides ${renderedCount}/${total}`)
    }
  }

  const streamHandler: SummaryStreamHandler = createSlidesSummaryStreamHandler({
    stdout: io.stdout,
    env: io.env,
    envForRun: io.envForRun,
    plain: flags.plain,
    outputMode: outputMode ?? 'line',
    clearProgressForStdout,
    restoreProgressAfterStdout,
    renderSlide,
    getSlideIndexOrder: () => state.getOrder(),
    getSlideMeta: (index) => {
      const total = state.getOrder().length || (slides?.slides.length ?? 0)
      const slide = state.getSlide(index)
      const timestamp =
        typeof slide?.timestamp === 'number' && Number.isFinite(slide.timestamp)
          ? slide.timestamp
          : null
      return { total, timestamp }
    },
    debugWrite:
      io.envForRun.SUMMARIZE_DEBUG_SLIDE_MARKERS &&
      io.envForRun.SUMMARIZE_DEBUG_SLIDE_MARKERS !== '0'
        ? (text: string) => io.stderr.write(text)
        : null,
  })

  const renderFromText = async (text: string) => {
    await streamHandler.onChunk({ streamed: text, prevStreamed: '', appended: text })
    await streamHandler.onDone?.(text)
  }

  return {
    onSlidesExtracted,
    onSlidesDone,
    onSlideChunk,
    streamHandler,
    renderFromText,
  }
}

export function createSlidesSummaryStreamHandler({
  stdout,
  env,
  envForRun,
  plain,
  outputMode,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  renderSlide,
  getSlideIndexOrder,
  getSlideMeta,
  debugWrite,
}: {
  stdout: NodeJS.WritableStream
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  plain: boolean
  outputMode: StreamOutputMode
  clearProgressForStdout: () => void
  restoreProgressAfterStdout?: (() => void) | null
  renderSlide: (index: number, title?: string | null) => Promise<void>
  getSlideIndexOrder: () => number[]
  getSlideMeta?: ((index: number) => { total: number; timestamp: number | null }) | null
  debugWrite?: ((text: string) => void) | null
}): SummaryStreamHandler {
  const shouldRenderMarkdown = !plain && isRichTty(stdout)
  const outputGate = !shouldRenderMarkdown
    ? createStreamOutputGate({
        stdout,
        clearProgressForStdout,
        restoreProgressAfterStdout: restoreProgressAfterStdout ?? null,
        outputMode,
        richTty: isRichTty(stdout),
      })
    : null
  const streamer = shouldRenderMarkdown
    ? createMarkdownStreamer({
        render: (markdown) =>
          renderMarkdownAnsi(prepareMarkdownForTerminalStreaming(markdown), {
            width: markdownRenderWidth(stdout, env),
            wrap: true,
            color: supportsColor(stdout, envForRun),
            hyperlinks: true,
          }),
        spacing: 'single',
      })
    : null

  let wroteLeadingBlankLine = false
  let buffered = ''
  const renderedSlides = new Set<number>()
  let visible = ''
  let pendingSlide: { index: number; buffer: string } | null = null
  const slideTagRegex = /\[[^\]]*slide[^\d\]]*(\d+)[^\]]*\]/i
  const slideLabelRegex =
    /(^|\n)[\t ]*slide\s+(\d+)(?:\s*(?:\/|of)\s*\d+)?(?:\s*[\u00b7:-].*)?(?=\n|$)/i
  const slideStripRegex = /\[[^\]]*slide[^\]]*\]/gi

  const handleMarkdownChunk = (nextVisible: string, prevVisible: string) => {
    if (!streamer) return
    const appended = nextVisible.slice(prevVisible.length)
    if (!appended) return
    const out = streamer.push(appended)
    if (!out) return
    clearProgressForStdout()
    if (!wroteLeadingBlankLine) {
      stdout.write(`\n${out.replace(/^\n+/, '')}`)
      wroteLeadingBlankLine = true
    } else {
      stdout.write(out)
    }
    restoreProgressAfterStdout?.()
  }

  const pushVisible = (segment: string) => {
    if (!segment) return
    const sanitized = segment.replace(slideStripRegex, '')
    if (!sanitized) return
    const prevVisible = visible
    visible += sanitized
    if (outputGate) {
      outputGate.handleChunk(visible, prevVisible)
      return
    }
    handleMarkdownChunk(visible, prevVisible)
  }

  const pushVisibleLines = (segment: string) => {
    if (!segment) return
    const parts = segment.split('\n')
    for (let i = 0; i < parts.length; i += 1) {
      const line = parts[i] ?? ''
      const suffix = i < parts.length - 1 ? '\n' : ''
      if (!line && !suffix) continue
      pushVisible(`${line}${suffix}`)
    }
  }

  const flushPendingSlide = async (force: boolean) => {
    if (!pendingSlide) return
    const text = pendingSlide.buffer
    if (!text.trim()) {
      if (force) {
        const index = pendingSlide.index
        pendingSlide = null
        await renderSlideBlock(index, null)
      }
      return
    }

    const index = pendingSlide.index
    const meta = getSlideMeta?.(index)
    const total = meta?.total ?? getSlideIndexOrder().length
    const newlineIndex = text.indexOf('\n')
    const shouldResolve = force || newlineIndex !== -1 || text.length >= 160
    if (!shouldResolve) return

    const parsed = splitSlideTitleFromText({
      text,
      slideIndex: index,
      total,
    })
    if (parsed.title && !parsed.body && !force) {
      return
    }
    const title = parsed.title ?? null
    const body = parsed.body
    pendingSlide = null
    await renderSlideBlock(index, title)
    if (body.trim()) pushVisibleLines(body)
  }

  const appendVisible = async (segment: string) => {
    if (!segment) return
    const sanitized = segment.replace(slideStripRegex, '')
    if (!sanitized) return
    if (pendingSlide) {
      pendingSlide.buffer += sanitized
      await flushPendingSlide(false)
      return
    }
    pushVisible(sanitized)
  }

  const renderSlideBlock = async (index: number, title?: string | null) => {
    if (renderedSlides.has(index)) return
    renderedSlides.add(index)
    await renderSlide(index, title)
  }

  const flushBuffered = async ({ final }: { final: boolean }) => {
    while (buffered.length > 0) {
      const tagMatch = slideTagRegex.exec(buffered)
      const labelMatch = slideLabelRegex.exec(buffered)
      const lower = buffered.toLowerCase()
      const fallbackStart = lower.indexOf('[slide')
      const fallbackEnd = fallbackStart >= 0 ? buffered.indexOf(']', fallbackStart) : -1
      const fallbackMatch =
        fallbackStart >= 0 && fallbackEnd > fallbackStart
          ? { start: fallbackStart, end: fallbackEnd }
          : null
      const nextMatch =
        tagMatch && labelMatch
          ? (tagMatch.index ?? 0) <= (labelMatch.index ?? 0)
            ? { kind: 'tag' as const, match: tagMatch }
            : { kind: 'label' as const, match: labelMatch }
          : tagMatch
            ? { kind: 'tag' as const, match: tagMatch }
            : labelMatch
              ? { kind: 'label' as const, match: labelMatch }
              : fallbackMatch
                ? { kind: 'fallback' as const, match: fallbackMatch }
                : null

      if (!nextMatch) {
        if (final) {
          await appendVisible(buffered)
          buffered = ''
          return
        }
        let start = lower.lastIndexOf('[slide')
        if (start === -1) {
          const bracket = lower.lastIndexOf('[')
          if (bracket !== -1) {
            const tail = lower.slice(bracket + 1).replace(/\s+/g, '')
            if (tail === '' || 'slide'.startsWith(tail)) {
              start = bracket
            }
          }
        }
        if (start === -1) {
          await appendVisible(buffered)
          buffered = ''
          return
        }
        const head = buffered.slice(0, start)
        await appendVisible(head)
        buffered = buffered.slice(start)
        return
      }
      const matchIndex =
        nextMatch.kind === 'fallback' ? nextMatch.match.start : (nextMatch.match.index ?? 0)
      const matchLength =
        nextMatch.kind === 'fallback'
          ? nextMatch.match.end - nextMatch.match.start + 1
          : nextMatch.match[0].length
      const rawTag = buffered.slice(matchIndex, matchIndex + matchLength)
      const before = buffered.slice(0, matchIndex)
      const after = buffered.slice(matchIndex + matchLength)
      if (pendingSlide) {
        await appendVisible(before)
        await flushPendingSlide(true)
      } else {
        await appendVisible(before)
      }
      buffered = after
      let index: number | null = null
      if (nextMatch.kind === 'fallback') {
        const digitMatch = rawTag.match(/(\d+)/)
        index = digitMatch ? Number.parseInt(digitMatch[1] ?? '', 10) : null
      } else {
        const rawIndex =
          nextMatch.kind === 'tag' ? nextMatch.match[1] : (nextMatch.match[2] ?? nextMatch.match[1])
        index = Number.parseInt(rawIndex ?? '', 10)
      }
      if (debugWrite) {
        debugWrite(
          `slides marker: ${nextMatch.kind} raw=${JSON.stringify(rawTag)} index=${index ?? 'null'}\n`
        )
      }
      if (Number.isFinite(index) && (index ?? 0) > 0) {
        if (getSlideMeta) {
          pendingSlide = { index: index as number, buffer: '' }
        } else {
          await renderSlideBlock(index as number, null)
        }
      }
    }
  }

  return {
    onChunk: async ({ appended }) => {
      if (!appended) return
      buffered += appended
      await flushBuffered({ final: false })
    },
    onDone: async () => {
      await flushBuffered({ final: true })
      if (pendingSlide) {
        await flushPendingSlide(true)
      }
      const ordered = getSlideIndexOrder()
      for (const index of ordered) {
        if (!renderedSlides.has(index)) {
          await renderSlideBlock(index, null)
        }
      }
      if (outputGate) {
        outputGate.finalize(visible)
        return
      }
      const out = streamer?.finish()
      if (out) {
        clearProgressForStdout()
        if (!wroteLeadingBlankLine) {
          stdout.write(`\n${out.replace(/^\n+/, '')}`)
          wroteLeadingBlankLine = true
        } else {
          stdout.write(out)
        }
        restoreProgressAfterStdout?.()
      } else if (visible && !wroteLeadingBlankLine) {
        clearProgressForStdout()
        stdout.write(`\n${visible.trim()}\n`)
        restoreProgressAfterStdout?.()
      }
    },
  }
}

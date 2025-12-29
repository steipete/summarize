import { defineContentScript } from 'wxt/utils/define-content-script'

import { mergeStreamingChunk } from '../../../../src/shared/streaming-merge.js'
import { loadSettings, type Settings } from '../lib/settings'

type HoverCacheEntry = {
  summary: string
  updatedAt: number
}

const HOVER_DELAY_MS = 420
const CACHE_TTL_MS = 12 * 60 * 1000
const TOOLTIP_ID = '__summarize_hover_tooltip__'
const STYLE_ID = '__summarize_hover_tooltip_style__'
const ERRORISH_PATTERN =
  /(^error:|failed to load|failed to fetch|failed to connect|unable to load|unable to fetch|unable to connect|cannot access|cannot summarize|something went wrong|try again|technical error|privacy[- ]related|please disable|access denied|forbidden|captcha|verify you are human|enable javascript|cloudflare|rate limit|too many requests|temporarily unavailable|page not found|not found|404|403|500|shortened t\\.co|t\\.co url|no summary returned|summary failed|daemon unreachable|not logged in|log in to|login to|sign in to|formerly twitter|please provide the text content|provided content.*empty)/i

function isValidUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw)
}

function resolveUrl(anchor: HTMLAnchorElement): string | null {
  const raw = anchor.getAttribute('href')?.trim() ?? ''
  if (!raw) return null
  if (raw.startsWith('#')) return null
  if (raw.startsWith('javascript:')) return null
  if (raw.startsWith('mailto:')) return null
  if (raw.startsWith('tel:')) return null
  try {
    const url = new URL(raw, location.href)
    if (!isValidUrl(url.href)) return null
    return url.href
  } catch {
    return null
  }
}

function clampText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function looksLikeErrorText(input: string): boolean {
  const text = clampText(input)
  if (!text) return false
  return ERRORISH_PATTERN.test(text)
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #${TOOLTIP_ID} {
      position: fixed;
      z-index: 2147483647;
      max-width: min(420px, 92vw);
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(18, 18, 18, 0.96);
      color: #f4f4f4;
      font: 12.5px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.2);
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px) scale(0.98);
      transition: opacity 120ms ease, transform 120ms ease;
    }

    #${TOOLTIP_ID}[data-visible="true"] {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    #${TOOLTIP_ID} .summary {
      display: -webkit-box;
      -webkit-line-clamp: 8;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    #${TOOLTIP_ID} .status {
      opacity: 0.7;
      font-style: italic;
    }
  `
  document.documentElement.append(style)
}

type Tooltip = {
  el: HTMLDivElement
  textEl: HTMLDivElement
}

type HoverFromBg =
  | { type: 'hover:chunk'; requestId: string; url: string; text: string }
  | { type: 'hover:done'; requestId: string; url: string }
  | { type: 'hover:error'; requestId: string; url: string; message: string }

function ensureTooltip(): Tooltip {
  ensureStyle()
  let el = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null
  if (!el) {
    el = document.createElement('div')
    el.id = TOOLTIP_ID
    el.setAttribute('role', 'tooltip')
    const textEl = document.createElement('div')
    textEl.className = 'summary'
    el.append(textEl)
    document.documentElement.append(el)
    return { el, textEl }
  }
  const textEl = el.querySelector('.summary') as HTMLDivElement | null
  if (!textEl) {
    const nextText = document.createElement('div')
    nextText.className = 'summary'
    el.append(nextText)
    return { el, textEl: nextText }
  }
  return { el, textEl }
}

function positionTooltip(anchor: HTMLElement, tooltip: Tooltip) {
  const rect = anchor.getBoundingClientRect()
  const tooltipRect = tooltip.el.getBoundingClientRect()
  const margin = 10
  let top = rect.bottom + margin
  const fitsBelow = top + tooltipRect.height + margin <= window.innerHeight
  if (!fitsBelow) {
    top = rect.top - tooltipRect.height - margin
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin))

  let left = rect.left + rect.width / 2 - tooltipRect.width / 2
  left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin))

  tooltip.el.style.top = `${Math.round(top)}px`
  tooltip.el.style.left = `${Math.round(left)}px`
}

function showTooltip(anchor: HTMLElement, text: string, { status = false } = {}) {
  if (looksLikeErrorText(text)) {
    hideTooltip()
    return
  }
  const tooltip = ensureTooltip()
  tooltip.textEl.textContent = text
  tooltip.textEl.classList.toggle('status', status)
  tooltip.el.dataset.visible = 'true'
  requestAnimationFrame(() => positionTooltip(anchor, tooltip))
}

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null
  if (!el) return
  delete el.dataset.visible
}

function isAnchorTarget(eventTarget: EventTarget | null): HTMLAnchorElement | null {
  if (!(eventTarget instanceof Element)) return null
  return eventTarget.closest('a[href]')
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    const flag = '__summarize_hover_installed__'
    if ((globalThis as unknown as Record<string, unknown>)[flag]) return
    ;(globalThis as unknown as Record<string, unknown>)[flag] = true

    let settings: Settings | null = null
    let settingsLoaded = false
    const refreshSettings = async () => {
      settings = await loadSettings()
      settingsLoaded = true
    }
    void refreshSettings()
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      if (!changes.settings) return
      void refreshSettings()
    })

    const cache = new Map<string, HoverCacheEntry>()
    let hoverTimer: number | null = null
    let activeAnchor: HTMLAnchorElement | null = null
    let activeUrl = ''
    let activeRequestId = ''
    let activeSummary = ''
    let activeHasChunk = false
    let activeHasShown = false
    let renderQueued = 0
    let cachedScrollHandler = 0

    const clearHoverTimer = () => {
      if (hoverTimer == null) return
      window.clearTimeout(hoverTimer)
      hoverTimer = null
    }

    const abortActive = () => {
      if (!activeRequestId) return
      try {
        void chrome.runtime.sendMessage({ type: 'hover:abort', requestId: activeRequestId })
      } catch {
        // ignore
      }
      activeRequestId = ''
      activeSummary = ''
      activeHasChunk = false
      activeHasShown = false
    }

    const clearActive = () => {
      clearHoverTimer()
      abortActive()
      activeAnchor = null
      activeUrl = ''
      hideTooltip()
    }

    chrome.runtime.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== 'object') return
      const msg = raw as Partial<HoverFromBg>
      if (!msg.type) return
      if (msg.type !== 'hover:chunk' && msg.type !== 'hover:done' && msg.type !== 'hover:error') {
        return
      }

      if (!activeAnchor) return
      if (!activeUrl) return
      if (!activeRequestId) return
      if (msg.requestId !== activeRequestId) return
      if (msg.url !== activeUrl) return

      if (msg.type === 'hover:chunk') {
        activeHasChunk = true
        const merged = mergeStreamingChunk(activeSummary, msg.text ?? '')
        activeSummary = merged.next
        const cleaned = clampText(activeSummary)
        if (cleaned) {
          if (!looksLikeErrorText(cleaned)) {
            showTooltip(activeAnchor, cleaned)
            activeHasShown = true
          } else {
            hideTooltip()
          }
        }
        return
      }

      if (msg.type === 'hover:done') {
        if (!activeHasChunk) {
          hideTooltip()
          return
        }
        const finalText = clampText(activeSummary)
        if (finalText && !looksLikeErrorText(finalText)) {
          cache.set(activeUrl, { summary: finalText, updatedAt: Date.now() })
          showTooltip(activeAnchor, finalText)
          activeHasShown = true
        } else {
          if (!activeHasShown) hideTooltip()
        }
        return
      }

      if (msg.type === 'hover:error') {
        if (!activeHasShown) hideTooltip()
      }
    })

    const scheduleReposition = () => {
      if (!activeAnchor) return
      if (renderQueued) return
      renderQueued = window.requestAnimationFrame(() => {
        renderQueued = 0
        if (!activeAnchor) return
        const tooltip = ensureTooltip()
        positionTooltip(activeAnchor, tooltip)
      })
    }

    const ensureScrollHandler = () => {
      if (cachedScrollHandler) return
      cachedScrollHandler = 1
      window.addEventListener('scroll', scheduleReposition, { passive: true })
      window.addEventListener('resize', scheduleReposition)
    }

    const scheduleHover = (anchor: HTMLAnchorElement) => {
      clearHoverTimer()
      hoverTimer = window.setTimeout(() => {
        hoverTimer = null
        void handleHover(anchor)
      }, HOVER_DELAY_MS)
    }

    const handleHover = async (anchor: HTMLAnchorElement) => {
      if (!settingsLoaded) await refreshSettings()
      if (!settings?.hoverSummaries) return
      const url = resolveUrl(anchor)
      if (!url) return
      if (!settings.token.trim()) return

      activeAnchor = anchor
      activeUrl = url
      ensureScrollHandler()

      const cached = cache.get(url)
      if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
        if (looksLikeErrorText(cached.summary)) {
          cache.delete(url)
          return
        }
        showTooltip(anchor, cached.summary)
        activeHasShown = true
        return
      }

      abortActive()
      activeRequestId =
        typeof crypto?.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`
      activeSummary = ''
      activeHasChunk = false
      activeHasShown = false

      try {
        // Important: do NOT `fetch("http://127.0.0.1:8787/...")` from the page/content-script context.
        // Chrome may attribute the request to the current origin and show the “Local network access” prompt
        // on every site. Proxy through the extension background service worker instead.
        const res = (await chrome.runtime.sendMessage({
          type: 'hover:summarize',
          requestId: activeRequestId,
          url,
          title: anchor.textContent?.trim() || null,
        })) as { ok?: boolean; error?: string }

        if (!res?.ok) throw new Error(res?.error || 'Failed to start hover summary')
      } catch {
        if (activeAnchor && activeUrl === url) {
          if (!activeHasShown) hideTooltip()
        }
      }
    }

    document.addEventListener('pointerover', (event) => {
      if (!(event instanceof PointerEvent)) return
      const anchor = isAnchorTarget(event.target)
      if (!anchor) return
      if (activeAnchor === anchor) return
      clearActive()
      scheduleHover(anchor)
    })

    document.addEventListener('pointerout', (event) => {
      if (!(event instanceof PointerEvent)) return
      if (!activeAnchor) return
      if (event.relatedTarget && activeAnchor.contains(event.relatedTarget as Node)) return
      clearActive()
    })

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') clearActive()
    })
  },
})

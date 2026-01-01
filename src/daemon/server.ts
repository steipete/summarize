import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { Writable } from 'node:stream'
import type { CacheState } from '../cache.js'
import { loadSummarizeConfig } from '../config.js'
import { createDaemonLogger } from '../logging/daemon.js'
import { refreshFree } from '../refresh-free.js'
import { createCacheStateFromConfig, refreshCacheStoreIfMissing } from '../run/cache-state.js'
import { formatModelLabelForDisplay } from '../run/finish-line.js'
import { resolveRunOverrides } from '../run/run-settings.js'
import { encodeSseEvent, type SseEvent } from '../shared/sse-events.js'
import { resolvePackageVersion } from '../version.js'
import { completeAgentResponse } from './agent.js'
import { type DaemonRequestedMode, resolveAutoDaemonMode } from './auto-mode.js'
import type { DaemonConfig } from './config.js'
import { DAEMON_HOST, DAEMON_PORT_DEFAULT } from './constants.js'
import { buildModelPickerOptions } from './models.js'
import {
  extractContentForUrl,
  streamSummaryForUrl,
  streamSummaryForVisiblePage,
} from './summarize.js'

type SessionEvent = SseEvent

type Session = {
  id: string
  createdAtMs: number
  buffer: Array<{ event: SessionEvent; bytes: number }>
  bufferBytes: number
  done: boolean
  clients: Set<http.ServerResponse>
  lastMeta: {
    model: string | null
    modelLabel: string | null
    inputSummary: string | null
    summaryFromCache: boolean | null
  }
}

function json(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers?: Record<string, string>
) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body).toString(),
    ...headers,
  })
  res.end(body)
}

function text(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers?: Record<string, string>
) {
  const out = body.endsWith('\n') ? body : `${body}\n`
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(out).toString(),
    ...headers,
  })
  res.end(out)
}

function resolveOriginHeader(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return null
  if (!origin.trim()) return null
  return origin
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    // Chrome Private Network Access (PNA): allow requests to localhost from secure contexts.
    // Without this, extensions often fail with a generic "Failed to fetch".
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

function readBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const m = header.match(/^Bearer\s+(.+)\s*$/i)
  return m?.[1]?.trim() || null
}

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > maxBytes) throw new Error(`Body too large (>${maxBytes} bytes)`)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}

function parseDiagnostics(raw: unknown): { includeContent: boolean } {
  if (!raw || typeof raw !== 'object') {
    return { includeContent: false }
  }
  const obj = raw as Record<string, unknown>
  return { includeContent: Boolean(obj.includeContent) }
}

function createLineWriter(onLine: (line: string) => void) {
  let buffer = ''
  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString()
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trimEnd()
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) onLine(line)
        index = buffer.indexOf('\n')
      }
      callback()
    },
    final(callback) {
      const line = buffer.trim()
      if (line) onLine(line)
      buffer = ''
      callback()
    },
  })
}

function createSession(): Session {
  return {
    id: randomUUID(),
    createdAtMs: Date.now(),
    buffer: [],
    bufferBytes: 0,
    done: false,
    clients: new Set(),
    lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
  }
}

const MAX_SESSION_BUFFER_EVENTS = 2000
const MAX_SESSION_BUFFER_BYTES = 512 * 1024

function pushToSession(
  session: Session,
  evt: SessionEvent,
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null
) {
  const encoded = encodeSseEvent(evt)
  for (const res of session.clients) {
    res.write(encoded)
  }
  onSessionEvent?.(evt, session.id)
  const bytes = Buffer.byteLength(encoded)
  session.buffer.push({ event: evt, bytes })
  session.bufferBytes += bytes
  while (
    session.buffer.length > MAX_SESSION_BUFFER_EVENTS ||
    session.bufferBytes > MAX_SESSION_BUFFER_BYTES
  ) {
    const removed = session.buffer.shift()
    if (!removed) break
    session.bufferBytes -= removed.bytes
  }
  if (evt.event === 'done' || evt.event === 'error') {
    session.done = true
  }
}

function emitMeta(
  session: Session,
  patch: Partial<{
    model: string | null
    modelLabel: string | null
    inputSummary: string | null
    summaryFromCache: boolean | null
  }>,
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null
) {
  const next = { ...session.lastMeta, ...patch }
  if (
    next.model === session.lastMeta.model &&
    next.modelLabel === session.lastMeta.modelLabel &&
    next.inputSummary === session.lastMeta.inputSummary &&
    next.summaryFromCache === session.lastMeta.summaryFromCache
  ) {
    return
  }
  session.lastMeta = next
  pushToSession(session, { event: 'meta', data: next }, onSessionEvent)
}

function endSession(session: Session) {
  for (const res of session.clients) {
    res.end()
  }
  session.clients.clear()
}

export function buildHealthPayload(importMetaUrl?: string) {
  return { ok: true, pid: process.pid, version: resolvePackageVersion(importMetaUrl) }
}

export async function runDaemonServer({
  env,
  fetchImpl,
  config,
  port = config.port ?? DAEMON_PORT_DEFAULT,
  signal,
  onListening,
  onSessionEvent,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  config: DaemonConfig
  port?: number
  signal?: AbortSignal
  onListening?: ((port: number) => void) | null
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null
}): Promise<void> {
  const { config: summarizeConfig } = loadSummarizeConfig({ env })
  const daemonLogger = createDaemonLogger({ env, config: summarizeConfig })
  const cacheState = await createCacheStateFromConfig({
    envForRun: env,
    config: summarizeConfig,
    noCacheFlag: false,
    transcriptNamespace: 'yt:auto',
  })

  const sessions = new Map<string, Session>()
  const refreshSessions = new Map<string, Session>()
  let activeRefreshSessionId: string | null = null

  const server = http.createServer((req, res) => {
    void (async () => {
      const origin = resolveOriginHeader(req)
      const cors = corsHeaders(origin)

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors)
        res.end()
        return
      }

      const url = new URL(req.url ?? '/', `http://${DAEMON_HOST}:${port}`)
      const pathname = url.pathname

      if (req.method === 'GET' && pathname === '/health') {
        json(res, 200, buildHealthPayload(import.meta.url), cors)
        return
      }

      const token = readBearerToken(req)
      const authed = token && token === config.token
      if (pathname.startsWith('/v1/') && !authed) {
        json(res, 401, { ok: false, error: 'unauthorized' }, cors)
        return
      }

      if (req.method === 'GET' && pathname === '/v1/ping') {
        json(res, 200, { ok: true }, cors)
        return
      }

      if (req.method === 'GET' && pathname === '/v1/models') {
        const result = await buildModelPickerOptions({
          env,
          envForRun: env,
          configForCli: summarizeConfig,
          fetchImpl,
        })
        json(res, 200, result, cors)
        return
      }

      if (req.method === 'POST' && pathname === '/v1/refresh-free') {
        if (activeRefreshSessionId) {
          json(res, 200, { ok: true, id: activeRefreshSessionId, running: true }, cors)
          return
        }

        const session = createSession()
        refreshSessions.set(session.id, session)
        activeRefreshSessionId = session.id
        json(res, 200, { ok: true, id: session.id }, cors)

        void (async () => {
          const pushStatus = (text: string) => {
            pushToSession(session, { event: 'status', data: { text } }, onSessionEvent)
          }
          try {
            pushStatus('Refresh free: starting…')
            const stdout = createLineWriter(pushStatus)
            const stderr = createLineWriter(pushStatus)
            await refreshFree({ env, fetchImpl, stdout, stderr })
            pushToSession(session, { event: 'done', data: {} }, onSessionEvent)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            pushToSession(session, { event: 'error', data: { message } }, onSessionEvent)
            console.error('[summarize-daemon] refresh-free failed', error)
          } finally {
            if (activeRefreshSessionId === session.id) {
              activeRefreshSessionId = null
            }
            setTimeout(() => {
              refreshSessions.delete(session.id)
              endSession(session)
            }, 60_000).unref()
          }
        })()
        return
      }

      if (req.method === 'POST' && pathname === '/v1/summarize') {
        await refreshCacheStoreIfMissing({ cacheState, transcriptNamespace: 'yt:auto' })
        let body: unknown
        try {
          body = await readJsonBody(req, 2_000_000)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, 400, { ok: false, error: message }, cors)
          return
        }
        if (!body || typeof body !== 'object') {
          json(res, 400, { ok: false, error: 'invalid json' }, cors)
          return
        }
        const obj = body as Record<string, unknown>
        const pageUrl = typeof obj.url === 'string' ? obj.url.trim() : ''
        const title = typeof obj.title === 'string' ? obj.title.trim() : null
        const textContent = typeof obj.text === 'string' ? obj.text : ''
        const truncated = Boolean(obj.truncated)
        const modelOverride = typeof obj.model === 'string' ? obj.model.trim() : null
        const lengthRaw = typeof obj.length === 'string' ? obj.length.trim() : ''
        const languageRaw = typeof obj.language === 'string' ? obj.language.trim() : ''
        const promptRaw = typeof obj.prompt === 'string' ? obj.prompt : ''
        const promptOverride = promptRaw.trim() || null
        const noCache = Boolean(obj.noCache)
        const extractOnly = Boolean(obj.extractOnly)
        const modeRaw = typeof obj.mode === 'string' ? obj.mode.trim().toLowerCase() : ''
        const mode: DaemonRequestedMode =
          modeRaw === 'url' ? 'url' : modeRaw === 'page' ? 'page' : 'auto'
        const maxCharacters =
          typeof obj.maxCharacters === 'number' && Number.isFinite(obj.maxCharacters)
            ? obj.maxCharacters
            : null
        const formatRaw = typeof obj.format === 'string' ? obj.format.trim().toLowerCase() : ''
        const format: 'text' | 'markdown' =
          formatRaw === 'markdown' || formatRaw === 'md' ? 'markdown' : 'text'
        const overrides = resolveRunOverrides({
          firecrawl: obj.firecrawl,
          markdownMode: obj.markdownMode,
          preprocess: obj.preprocess,
          youtube: obj.youtube,
          videoMode: obj.videoMode,
          timestamps: obj.timestamps,
          timeout: obj.timeout,
          retries: obj.retries,
          maxOutputTokens: obj.maxOutputTokens,
          transcriber: obj.transcriber,
        })
        const diagnostics = parseDiagnostics(obj.diagnostics)
        const includeContentLog = daemonLogger.enabled && diagnostics.includeContent
        const hasText = Boolean(textContent.trim())
        if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
          json(res, 400, { ok: false, error: 'missing url' }, cors)
          return
        }
        if (extractOnly) {
          if (mode === 'page') {
            json(res, 400, { ok: false, error: 'extractOnly requires mode=url' }, cors)
            return
          }
          try {
            const requestCache: CacheState = noCache
              ? { ...cacheState, mode: 'bypass' as const, store: null }
              : cacheState
            const extracted = await extractContentForUrl({
              env,
              fetchImpl,
              input: { url: pageUrl, title, maxCharacters },
              cache: requestCache,
              overrides,
              format,
            })
            json(
              res,
              200,
              {
                ok: true,
                extracted: {
                  content: extracted.content,
                  title: extracted.title,
                  url: extracted.url,
                  wordCount: extracted.wordCount,
                  totalCharacters: extracted.totalCharacters,
                  truncated: extracted.truncated,
                  transcriptSource: extracted.transcriptSource ?? null,
                  transcriptCharacters: extracted.transcriptCharacters ?? null,
                  transcriptWordCount: extracted.transcriptWordCount ?? null,
                  transcriptLines: extracted.transcriptLines ?? null,
                  transcriptSegments: extracted.transcriptSegments ?? null,
                  transcriptTimedText: extracted.transcriptTimedText ?? null,
                  transcriptionProvider: extracted.transcriptionProvider ?? null,
                  mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
                  diagnostics: extracted.diagnostics,
                },
              },
              cors
            )
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            json(res, 500, { ok: false, error: message }, cors)
          }
          return
        }

        if (mode === 'page' && !hasText) {
          json(res, 400, { ok: false, error: 'missing text' }, cors)
          return
        }

        const session = createSession()
        sessions.set(session.id, session)
        const requestLogger = daemonLogger.getSubLogger('daemon.summarize', {
          requestId: session.id,
        })
        const logStartedAt = Date.now()
        let logSummaryFromCache = false
        let logInputSummary: string | null = null
        let logSummaryText = ''
        let logExtracted: Record<string, unknown> | null = null
        const logInput = includeContentLog
          ? {
              url: pageUrl,
              title,
              text: hasText ? textContent : null,
              truncated: hasText ? truncated : null,
            }
          : null
        requestLogger?.info({
          event: 'summarize.request',
          url: pageUrl,
          mode,
          hasText,
          noCache,
          length: lengthRaw,
          language: languageRaw,
          model: modelOverride,
          includeContent: includeContentLog,
        })

        json(res, 200, { ok: true, id: session.id }, cors)

        void (async () => {
          try {
            let emittedOutput = false
            const sink = {
              writeChunk: (chunk: string) => {
                emittedOutput = true
                if (includeContentLog) {
                  logSummaryText += chunk
                }
                pushToSession(session, { event: 'chunk', data: { text: chunk } }, onSessionEvent)
              },
              onModelChosen: (modelId: string) => {
                if (session.lastMeta.model === modelId) return
                emittedOutput = true
                emitMeta(
                  session,
                  {
                    model: modelId,
                    modelLabel: formatModelLabelForDisplay(modelId),
                  },
                  onSessionEvent
                )
              },
              writeStatus: (text: string) => {
                const clean = text.trim()
                if (!clean) return
                pushToSession(session, { event: 'status', data: { text: clean } }, onSessionEvent)
              },
              writeMeta: (data: {
                inputSummary?: string | null
                summaryFromCache?: boolean | null
              }) => {
                if (typeof data.inputSummary === 'string') {
                  logInputSummary = data.inputSummary
                }
                if (typeof data.summaryFromCache === 'boolean') {
                  logSummaryFromCache = data.summaryFromCache
                }
                emitMeta(
                  session,
                  {
                    inputSummary: typeof data.inputSummary === 'string' ? data.inputSummary : null,
                    summaryFromCache:
                      typeof data.summaryFromCache === 'boolean' ? data.summaryFromCache : null,
                  },
                  onSessionEvent
                )
              },
            }

            const normalizedModelOverride =
              modelOverride && modelOverride.toLowerCase() !== 'auto' ? modelOverride : null

            const requestCache: CacheState = noCache
              ? { ...cacheState, mode: 'bypass' as const, store: null }
              : cacheState

            const runWithMode = async (resolved: 'url' | 'page') => {
              return resolved === 'url'
                ? await streamSummaryForUrl({
                    env,
                    fetchImpl,
                    modelOverride: normalizedModelOverride,
                    promptOverride,
                    lengthRaw,
                    languageRaw,
                    format,
                    input: { url: pageUrl, title, maxCharacters },
                    sink,
                    cache: requestCache,
                    overrides,
                    hooks: includeContentLog
                      ? {
                          onExtracted: (content) => {
                            logExtracted = content as unknown as Record<string, unknown>
                          },
                        }
                      : null,
                  })
                : await streamSummaryForVisiblePage({
                    env,
                    fetchImpl,
                    modelOverride: normalizedModelOverride,
                    promptOverride,
                    lengthRaw,
                    languageRaw,
                    format,
                    input: { url: pageUrl, title, text: textContent, truncated },
                    sink,
                    cache: requestCache,
                    overrides,
                  })
            }

            const result = await (async () => {
              if (mode !== 'auto') return runWithMode(mode)

              const { primary, fallback } = resolveAutoDaemonMode({ url: pageUrl, hasText })

              try {
                return await runWithMode(primary)
              } catch (error) {
                if (!fallback || emittedOutput) throw error

                sink.writeStatus?.('Primary failed. Trying fallback…')
                try {
                  return await runWithMode(fallback)
                } catch (fallbackError) {
                  const primaryMessage = error instanceof Error ? error.message : String(error)
                  const fallbackMessage =
                    fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                  throw new Error(
                    `Auto mode failed.\nPrimary (${primary}): ${primaryMessage}\nFallback (${fallback}): ${fallbackMessage}`
                  )
                }
              }
            })()

            if (!session.lastMeta.model) {
              emitMeta(
                session,
                {
                  model: result.usedModel,
                  modelLabel: formatModelLabelForDisplay(result.usedModel),
                },
                onSessionEvent
              )
            }

            pushToSession(session, { event: 'metrics', data: result.metrics }, onSessionEvent)
            pushToSession(session, { event: 'done', data: {} }, onSessionEvent)
            requestLogger?.info({
              event: 'summarize.done',
              url: pageUrl,
              mode,
              model: result.usedModel,
              elapsedMs: Date.now() - logStartedAt,
              summaryFromCache: logSummaryFromCache,
              inputSummary: logInputSummary,
              ...(includeContentLog && !logSummaryFromCache
                ? {
                    input: logInput,
                    extracted: logExtracted,
                    summary: logSummaryText,
                  }
                : {}),
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            pushToSession(session, { event: 'error', data: { message } }, onSessionEvent)
            // Preserve full stack trace in daemon logs for debugging.
            console.error('[summarize-daemon] summarize failed', error)
            requestLogger?.error({
              event: 'summarize.error',
              url: pageUrl,
              mode,
              elapsedMs: Date.now() - logStartedAt,
              summaryFromCache: logSummaryFromCache,
              inputSummary: logInputSummary,
              error: {
                message,
                stack: error instanceof Error ? error.stack : null,
              },
              ...(includeContentLog && !logSummaryFromCache
                ? {
                    input: logInput,
                    extracted: logExtracted,
                    summary: logSummaryText || null,
                  }
                : {}),
            })
          } finally {
            setTimeout(() => {
              sessions.delete(session.id)
              endSession(session)
            }, 60_000).unref()
          }
        })()
        return
      }

      if (req.method === 'POST' && pathname === '/v1/agent') {
        let body: unknown
        try {
          body = await readJsonBody(req, 4_000_000)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          json(res, 400, { ok: false, error: message }, cors)
          return
        }
        if (!body || typeof body !== 'object') {
          json(res, 400, { ok: false, error: 'invalid json' }, cors)
          return
        }

        const obj = body as Record<string, unknown>
        const pageUrl = typeof obj.url === 'string' ? obj.url.trim() : ''
        const pageTitle = typeof obj.title === 'string' ? obj.title.trim() : null
        const pageContent = typeof obj.pageContent === 'string' ? obj.pageContent : ''
        const messages = obj.messages
        const modelOverride = typeof obj.model === 'string' ? obj.model.trim() : null
        const tools = Array.isArray(obj.tools)
          ? obj.tools.filter((tool): tool is string => typeof tool === 'string')
          : []
        const automationEnabled = Boolean(obj.automationEnabled)

        if (!pageUrl) {
          json(res, 400, { ok: false, error: 'missing url' }, cors)
          return
        }

        try {
          const assistant = await completeAgentResponse({
            env,
            pageUrl,
            pageTitle,
            pageContent,
            messages,
            modelOverride:
              modelOverride && modelOverride.toLowerCase() !== 'auto' ? modelOverride : null,
            tools,
            automationEnabled,
          })
          json(res, 200, { ok: true, assistant }, cors)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error('[summarize-daemon] agent failed', error)
          json(res, 500, { ok: false, error: message }, cors)
        }
        return
      }

      const eventsMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/events$/)
      if (req.method === 'GET' && eventsMatch) {
        const id = eventsMatch[1]
        if (!id) {
          json(res, 404, { ok: false }, cors)
          return
        }
        const session = sessions.get(id)
        if (!session) {
          json(res, 404, { ok: false, error: 'not found' }, cors)
          return
        }

        res.writeHead(200, {
          ...cors,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        session.clients.add(res)

        for (const entry of session.buffer) {
          res.write(encodeSseEvent(entry.event))
        }
        if (session.done) {
          res.end()
          session.clients.delete(res)
          return
        }

        const keepalive = setInterval(() => {
          res.write(`: keepalive ${Date.now()}\n\n`)
        }, 15_000)
        keepalive.unref()

        res.on('close', () => {
          clearInterval(keepalive)
          session.clients.delete(res)
        })
        return
      }

      const refreshEventsMatch = pathname.match(/^\/v1\/refresh-free\/([^/]+)\/events$/)
      if (req.method === 'GET' && refreshEventsMatch) {
        const id = refreshEventsMatch[1]
        if (!id) {
          json(res, 404, { ok: false }, cors)
          return
        }
        const session = refreshSessions.get(id)
        if (!session) {
          json(res, 404, { ok: false, error: 'not found' }, cors)
          return
        }

        res.writeHead(200, {
          ...cors,
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        session.clients.add(res)

        for (const entry of session.buffer) {
          res.write(encodeSseEvent(entry.event))
        }
        if (session.done) {
          res.end()
          session.clients.delete(res)
          return
        }

        const keepalive = setInterval(() => {
          res.write(`: keepalive ${Date.now()}\n\n`)
        }, 15_000)
        keepalive.unref()

        res.on('close', () => {
          clearInterval(keepalive)
          session.clients.delete(res)
        })
        return
      }

      text(res, 404, 'Not found', cors)
    })().catch((error) => {
      const origin = resolveOriginHeader(req)
      const cors = corsHeaders(origin)
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: message }, cors)
        return
      }
      try {
        res.end()
      } catch {
        // ignore
      }
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, DAEMON_HOST, () => {
        const address = server.address()
        const actualPort =
          address && typeof address === 'object' && typeof address.port === 'number'
            ? address.port
            : port
        onListening?.(actualPort)
        resolve()
      })
    })

    await new Promise<void>((resolve) => {
      let resolved = false
      const onStop = () => {
        if (resolved) return
        resolved = true
        server.close(() => resolve())
      }
      process.once('SIGTERM', onStop)
      process.once('SIGINT', onStop)
      if (signal) {
        if (signal.aborted) {
          onStop()
        } else {
          signal.addEventListener('abort', onStop, { once: true })
        }
      }
    })
  } finally {
    cacheState.store?.close()
  }
}

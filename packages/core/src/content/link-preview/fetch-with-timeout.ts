const DEFAULT_TIMEOUT_MS = 120_000

type FetchLike = typeof fetch
type FetchArguments = Parameters<typeof fetch>

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: FetchArguments[0],
  init?: FetchArguments[1],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  if (init?.signal) {
    return fetchImpl(input, init ?? {})
  }

  const controller = new AbortController()
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS
  const clampedTimeoutMs = Math.max(0, normalizedTimeoutMs)

  const timer = setTimeout(() => {
    if (typeof DOMException === 'function') {
      controller.abort(new DOMException('Request timed out', 'AbortError'))
      return
    }
    controller.abort()
  }, clampedTimeoutMs)

  try {
    const finalInit: RequestInit = {
      ...init,
      signal: controller.signal,
    }
    return await fetchImpl(input, finalInit)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutError = new Error(`Fetch aborted after ${clampedTimeoutMs}ms`)
      timeoutError.name = 'FetchTimeoutError'
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

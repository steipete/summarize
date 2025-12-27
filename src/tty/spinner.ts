import ora from 'ora'

export function startSpinner({
  text,
  enabled,
  stream,
}: {
  text: string
  enabled: boolean
  stream: NodeJS.WritableStream
}): {
  stop: () => void
  clear: () => void
  pause: () => void
  resume: () => void
  stopAndClear: () => void
  setText: (next: string) => void
} {
  if (!enabled) {
    return {
      stop: () => {},
      clear: () => {},
      pause: () => {},
      resume: () => {},
      stopAndClear: () => {},
      setText: () => {},
    }
  }

  let ended = false
  let paused = false

  const oraStream = stream as typeof stream & {
    cursorTo?: (x: number, y?: number) => void
    clearLine?: (dir: number) => void
    moveCursor?: (dx: number, dy: number) => void
  }

  if (typeof oraStream.cursorTo !== 'function') oraStream.cursorTo = () => {}
  if (typeof oraStream.clearLine !== 'function') oraStream.clearLine = () => {}
  if (typeof oraStream.moveCursor !== 'function') oraStream.moveCursor = () => {}

  const clear = () => {
    if (ended) return
    // Keep output clean in scrollback.
    // `ora` clears the line, but we also hard-clear as a fallback.
    spinner.clear()
    stream.write('\r\u001b[2K')
  }

  const pause = () => {
    if (ended || paused) return
    paused = true
    if (spinner.isSpinning) spinner.stop()
    spinner.clear()
    stream.write('\r\u001b[2K')
  }

  const resume = () => {
    if (ended || !paused) return
    paused = false
    spinner.start()
  }

  const stop = () => {
    if (ended) return
    ended = true
    if (spinner.isSpinning) spinner.stop()
  }

  const stopAndClear = () => {
    if (ended) return
    ended = true
    paused = false
    if (spinner.isSpinning) spinner.stop()
    spinner.clear()
    stream.write('\r\u001b[2K')
  }

  const setText = (next: string) => {
    if (ended) return
    spinner.text = next
    if (!paused) spinner.render?.()
  }

  const spinner = ora({
    text,
    stream: oraStream,
    // Match Sweetistics CLI vibe; keep it clean.
    spinner: 'dots12',
    color: 'cyan',
    discardStdin: true,
  }).start()

  return { stop, clear, pause, resume, stopAndClear, setText }
}

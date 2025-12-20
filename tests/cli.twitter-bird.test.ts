import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

function collectStream({ isTTY }: { isTTY: boolean }) {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  ;(stream as unknown as { isTTY?: boolean }).isTTY = isTTY
  ;(stream as unknown as { columns?: number }).columns = 120
  return { stream, getText: () => text }
}

// Deterministic spinner: write the initial text once; stop/clear are no-ops.
vi.mock('ora', () => {
  const ora = (opts: { text: string; stream: NodeJS.WritableStream }) => {
    let currentText = opts.text
    const spinner = {
      isSpinning: true,
      get text() {
        return currentText
      },
      set text(next: string) {
        currentText = next
        opts.stream.write(`\r${currentText}`)
      },
      stop() {
        spinner.isSpinning = false
      },
      clear() {},
      start() {
        opts.stream.write(`- ${spinner.text}`)
        return spinner
      },
    }
    return spinner
  }
  return { default: ora }
})

describe('cli bird status line', () => {
  it('shows bird in the status line when bird is used', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-bird-'))
    const binDir = join(root, 'bin')
    mkdirSync(binDir, { recursive: true })
    const birdPath = join(binDir, 'bird')
    writeFileSync(
      birdPath,
      '#!/bin/sh\necho \'{"id":"1","text":"Hello from bird","author":{"username":"birdy","name":"Bird"}}\'\n'
    )
    chmodSync(birdPath, 0o755)

    const stdout = collectStream({ isTTY: false })
    const stderr = collectStream({ isTTY: true })

    await runCli(['--extract-only', 'https://x.com/user/status/123'], {
      env: { HOME: root, PATH: binDir, TERM: 'xterm-256color' },
      fetch: vi.fn(async () => {
        throw new Error('unexpected fetch')
      }) as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    const rawErr = stderr.getText()
    expect(rawErr).toContain('Bird:')
  })
})

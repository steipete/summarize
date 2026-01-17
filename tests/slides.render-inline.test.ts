import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { renderSlidesInline } from '../src/run/slides-render.js'

const pngData = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=',
  'base64'
)

function createTtyStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  ;(stream as unknown as { isTTY?: boolean }).isTTY = true
  ;(stream as unknown as { columns?: number }).columns = 120
  return { stream, getText: () => text }
}

async function createTempSlide() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'summarize-slides-'))
  const imagePath = path.join(dir, 'slide_0001.png')
  await fs.writeFile(imagePath, pngData)
  return imagePath
}

describe('renderSlidesInline', () => {
  it('returns none when mode is disabled', async () => {
    const output = createTtyStream()
    const result = await renderSlidesInline({
      slides: [
        {
          index: 1,
          timestamp: 0,
          imagePath: '/tmp/missing.png',
        },
      ],
      mode: 'none',
      env: {},
      stdout: output.stream,
    })
    expect(result.protocol).toBe('none')
    expect(result.rendered).toBe(0)
    expect(output.getText()).toBe('')
  })

  it('renders kitty images when auto-detected', async () => {
    const imagePath = await createTempSlide()
    const output = createTtyStream()
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 12.3, imagePath }],
      mode: 'auto',
      env: { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' },
      stdout: output.stream,
      labelForSlide: () => 'Slide 1',
    })
    expect(result.protocol).toBe('kitty')
    expect(result.rendered).toBe(1)
    expect(output.getText()).toContain('Slide 1')
    expect(output.getText()).toContain('\u001b_G')
  })

  it('renders kitty images when Konsole is detected', async () => {
    const imagePath = await createTempSlide()
    const output = createTtyStream()
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 1.2, imagePath }],
      mode: 'auto',
      env: { TERM_PROGRAM: 'konsole' },
      stdout: output.stream,
    })
    expect(result.protocol).toBe('kitty')
    expect(result.rendered).toBe(1)
    expect(output.getText()).toContain('\u001b_G')
  })

  it('renders iTerm images when auto-detected', async () => {
    const imagePath = await createTempSlide()
    const output = createTtyStream()
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 4.2, imagePath }],
      mode: 'auto',
      env: { TERM_PROGRAM: 'iTerm.app' },
      stdout: output.stream,
    })
    expect(result.protocol).toBe('iterm')
    expect(result.rendered).toBe(1)
    expect(output.getText()).toContain('\u001b]1337;File=')
  })

  it('prints a missing image notice when slides are absent', async () => {
    const output = createTtyStream()
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 0, imagePath: '/tmp/missing-slide.png' }],
      mode: 'auto',
      env: { KITTY_WINDOW_ID: '1', TERM: 'xterm-kitty' },
      stdout: output.stream,
    })
    expect(result.protocol).toBe('kitty')
    expect(result.rendered).toBe(0)
    expect(output.getText()).toContain('(missing slide image)')
  })
})

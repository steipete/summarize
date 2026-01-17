import { describe, expect, it } from 'vitest'

import {
  ansi,
  isRichTty,
  markdownRenderWidth,
  supportsColor,
  terminalHeight,
  terminalWidth,
} from '../src/run/terminal.js'

const makeStream = (overrides: Partial<{ isTTY: boolean; columns: number; rows: number }> = {}) =>
  ({
    isTTY: overrides.isTTY,
    columns: overrides.columns,
    rows: overrides.rows,
  }) as unknown as NodeJS.WritableStream

describe('terminal helpers', () => {
  it('detects TTY streams', () => {
    expect(isRichTty(makeStream({ isTTY: true }))).toBe(true)
    expect(isRichTty(makeStream({ isTTY: false }))).toBe(false)
  })

  it('respects FORCE_COLOR and NO_COLOR', () => {
    const stream = makeStream({ isTTY: false })
    expect(supportsColor(stream, { FORCE_COLOR: '1' })).toBe(true)
    expect(supportsColor(makeStream({ isTTY: true }), { NO_COLOR: '1', TERM: 'xterm' })).toBe(false)
  })

  it('checks TERM and TTY for color support', () => {
    expect(supportsColor(makeStream({ isTTY: false }), { TERM: 'xterm' })).toBe(false)
    expect(supportsColor(makeStream({ isTTY: true }), { TERM: 'dumb' })).toBe(false)
    expect(supportsColor(makeStream({ isTTY: true }), { TERM: 'xterm' })).toBe(true)
  })

  it('resolves terminal dimensions', () => {
    expect(terminalWidth(makeStream({ columns: 120 }), {})).toBe(120)
    expect(terminalWidth(makeStream(), { COLUMNS: '90' })).toBe(90)
    expect(terminalWidth(makeStream(), {})).toBe(80)
    expect(terminalHeight(makeStream({ rows: 42 }), {})).toBe(42)
    expect(terminalHeight(makeStream(), { LINES: '33' })).toBe(33)
    expect(terminalHeight(makeStream(), {})).toBe(24)
  })

  it('adjusts markdown render width', () => {
    expect(markdownRenderWidth(makeStream({ columns: 80 }), {})).toBe(79)
    expect(markdownRenderWidth(makeStream({ columns: 10 }), {})).toBe(20)
  })

  it('wraps ANSI sequences when enabled', () => {
    expect(ansi('31', 'hi', false)).toBe('hi')
    expect(ansi('31', 'hi', true)).toBe('\u001b[31mhi\u001b[0m')
  })
})

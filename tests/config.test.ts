import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSummarizeConfig } from '../src/config.js'

const writeConfig = (raw: string) => {
  const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
  const configDir = join(root, '.summarize')
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, raw, 'utf8')
  return { root, configPath }
}

const writeJsonConfig = (value: unknown) => writeConfig(JSON.stringify(value))

describe('config loading', () => {
  it('loads ~/.summarize/config.json by default', () => {
    const { root, configPath } = writeJsonConfig({ model: { id: 'openai/gpt-5.2' } })

    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.path).toBe(configPath)
    expect(result.config).toEqual({ model: { id: 'openai/gpt-5.2' } })
  })

  it('loads auto model rules', () => {
    const { root, configPath } = writeJsonConfig({
      model: {
        mode: 'auto',
        rules: [
          { when: ['video'], candidates: ['google/gemini-3-flash-preview'] },
          {
            when: ['youtube', 'website'],
            candidates: ['openai/gpt-5-nano', 'xai/grok-4-fast-non-reasoning'],
          },
          { candidates: ['openai/gpt-5-nano', 'openrouter/openai/gpt-5-nano'] },
        ],
      },
      media: { videoMode: 'auto' },
    })

    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.path).toBe(configPath)
    expect(result.config).toEqual({
      model: {
        mode: 'auto',
        rules: [
          { when: ['video'], candidates: ['google/gemini-3-flash-preview'] },
          {
            when: ['youtube', 'website'],
            candidates: ['openai/gpt-5-nano', 'xai/grok-4-fast-non-reasoning'],
          },
          { candidates: ['openai/gpt-5-nano', 'openrouter/openai/gpt-5-nano'] },
        ],
      },
      media: { videoMode: 'auto' },
    })
  })

  it('supports model shorthand strings ("auto", bag, provider/model)', () => {
    const { root, configPath } = writeJsonConfig({ model: 'auto' })
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({ model: { mode: 'auto' } })

    writeFileSync(configPath, JSON.stringify({ model: 'mybag' }), 'utf8')
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({ model: { bag: 'mybag' } })

    writeFileSync(configPath, JSON.stringify({ model: 'openai/gpt-5-mini' }), 'utf8')
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { id: 'openai/gpt-5-mini' },
    })
  })

  it('returns null config when no config file exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const result = loadSummarizeConfig({ env: { HOME: root } })
    expect(result.config).toBeNull()
    expect(result.path).toBe(join(root, '.summarize', 'config.json'))
  })

  it('rejects JSON with line comments', () => {
    const { root } = writeConfig(`{\n// nope\n"model": "auto"\n}`)
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/comments are not allowed/)
  })

  it('rejects JSON with block comments', () => {
    const { root } = writeConfig(`/* nope */\n{"model": "auto"}`)
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/comments are not allowed/)
  })

  it('allows comment markers inside strings', () => {
    const { root } = writeConfig(`{"model": "openai/gpt-5.2", "url": "http://x"}`)
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { id: 'openai/gpt-5.2' },
    })
  })

  it('rejects invalid JSON', () => {
    const { root } = writeConfig('{')
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/Invalid JSON/)
  })

  it('rejects non-object top-level JSON', () => {
    const { root } = writeConfig('[]')
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/expected an object/)
  })

  it('rejects empty model string', () => {
    const { root } = writeJsonConfig({ model: '   ' })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/model.*must not be empty/)
  })

  it('rejects non-object model config', () => {
    const { root } = writeJsonConfig({ model: 42 })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/model.*must be an object/)
  })

  it('rejects empty model id', () => {
    const { root } = writeJsonConfig({ model: { id: '  ' } })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /model\.id.*must not be empty/
    )
  })

  it('rejects model configs without id, bag, or auto mode', () => {
    const { root } = writeJsonConfig({ model: {} })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/must include either "id"/)
  })

  it('loads named models (bags alias)', () => {
    const { root } = writeJsonConfig({
      model: 'auto',
      bags: {
        fast: { id: 'openai/gpt-5-mini' },
        or: 'openrouter/openai/gpt-5-mini',
      },
    })

    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { mode: 'auto' },
      models: {
        fast: { id: 'openai/gpt-5-mini' },
        or: { id: 'openrouter/openai/gpt-5-mini' },
      },
    })
  })

  it('rejects reserved bag name "auto"', () => {
    const { root } = writeJsonConfig({
      bags: { auto: { id: 'openai/gpt-5-mini' } },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/auto.*reserved/i)
  })

  it('rejects non-array model.rules', () => {
    const { root } = writeJsonConfig({ model: { mode: 'auto', rules: {} } })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /model\.rules.*must be an array/
    )
  })

  it('rejects invalid "when" values', () => {
    const { root: rootNotArray } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ when: 'video', candidates: ['openai/gpt-5.2'] }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootNotArray } })).toThrow(
      /when.*must be an array/
    )

    const { root: rootEmpty } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ when: [], candidates: ['openai/gpt-5.2'] }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootEmpty } })).toThrow(/must not be empty/)

    const { root: rootUnknown } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ when: ['nope'], candidates: ['openai/gpt-5.2'] }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootUnknown } })).toThrow(/unknown "when"/)
  })

  it('rejects invalid candidates and bands definitions', () => {
    const { root: rootBoth } = writeJsonConfig({
      model: {
        mode: 'auto',
        rules: [
          {
            candidates: ['openai/gpt-5.2'],
            bands: [{ candidates: ['openai/gpt-5.2'] }],
          },
        ],
      },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootBoth } })).toThrow(
      /either "candidates" or "bands"/
    )

    const { root: rootCandidatesNotArray } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ candidates: 'openai/gpt-5.2' }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootCandidatesNotArray } })).toThrow(
      /candidates.*array of strings/
    )

    const { root: rootCandidatesEmpty } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ candidates: ['   '] }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootCandidatesEmpty } })).toThrow(
      /candidates.*must not be empty/
    )

    const { root: rootBandsEmpty } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ bands: [] }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootBandsEmpty } })).toThrow(
      /bands.*non-empty array/
    )
  })

  it('rejects invalid token bands', () => {
    const { root: rootBandNotObject } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ bands: [1] }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootBandNotObject } })).toThrow(
      /bands\[\].*must be an object/
    )

    const { root: rootTokenNotObject } = writeJsonConfig({
      model: { mode: 'auto', rules: [{ bands: [{ candidates: ['openai/gpt-5.2'], token: 'x' }] }] },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootTokenNotObject } })).toThrow(
      /bands\[\]\.token.*must be an object/
    )

    const { root: rootMinInvalid } = writeJsonConfig({
      model: {
        mode: 'auto',
        rules: [{ bands: [{ candidates: ['openai/gpt-5.2'], token: { min: -1 } }] }],
      },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootMinInvalid } })).toThrow(/token\.min.*>= 0/)

    const { root: rootMaxInvalid } = writeJsonConfig({
      model: {
        mode: 'auto',
        rules: [{ bands: [{ candidates: ['openai/gpt-5.2'], token: { max: -1 } }] }],
      },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootMaxInvalid } })).toThrow(/token\.max.*>= 0/)

    const { root: rootMinMax } = writeJsonConfig({
      model: {
        mode: 'auto',
        rules: [{ bands: [{ candidates: ['openai/gpt-5.2'], token: { min: 10, max: 2 } }] }],
      },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootMinMax } })).toThrow(/min.*<=.*max/)
  })

  it('rejects rules without candidates or bands', () => {
    const { root } = writeJsonConfig({ model: { mode: 'auto', rules: [{}] } })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /must include "candidates" or "bands"/
    )
  })

  it('parses token bands and ignores invalid media values', () => {
    const { root } = writeJsonConfig({
      model: {
        mode: 'auto',
        rules: [
          {
            bands: [
              { candidates: ['openai/gpt-5.2'], token: { min: 100 } },
              { candidates: ['openai/gpt-5.2'], token: { max: 200 } },
              { candidates: ['openai/gpt-5.2'], token: {} },
            ],
          },
        ],
      },
      media: { videoMode: 'nope' },
    })
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: {
        mode: 'auto',
        rules: [
          {
            bands: [
              { candidates: ['openai/gpt-5.2'], token: { min: 100 } },
              { candidates: ['openai/gpt-5.2'], token: { max: 200 } },
              { candidates: ['openai/gpt-5.2'] },
            ],
          },
        ],
      },
    })
  })

  it('parses cli config overrides', () => {
    const { root } = writeJsonConfig({
      cli: {
        enabled: ['claude', 'gemini'],
        claude: {
          binary: '/opt/claude',
          model: 'sonnet',
          extraArgs: ['--foo'],
        },
        codex: {
          binary: 'codex',
        },
        promptOverride: 'Summarize this.',
        allowTools: true,
        cwd: '/tmp',
        extraArgs: ['--bar'],
      },
    })
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      cli: {
        enabled: ['claude', 'gemini'],
        claude: {
          binary: '/opt/claude',
          model: 'sonnet',
          extraArgs: ['--foo'],
        },
        codex: { binary: 'codex' },
        promptOverride: 'Summarize this.',
        allowTools: true,
        cwd: '/tmp',
        extraArgs: ['--bar'],
      },
    })
  })

  it('rejects invalid cli enabled providers', () => {
    const { root } = writeJsonConfig({ cli: { enabled: ['nope'] } })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/unknown CLI provider/)
  })

  it('rejects cli disabled and provider enabled flags', () => {
    const { root } = writeJsonConfig({ cli: { disabled: ['claude'] } })
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/cli\.disabled/)

    const { root: rootProvider } = writeJsonConfig({ cli: { claude: { enabled: true } } })
    expect(() => loadSummarizeConfig({ env: { HOME: rootProvider } })).toThrow(
      /cli\.claude\.enabled/
    )
  })

  it('rejects invalid cli extraArgs', () => {
    const { root: rootTop } = writeJsonConfig({ cli: { extraArgs: 'nope' } })
    expect(() => loadSummarizeConfig({ env: { HOME: rootTop } })).toThrow(/cli\.extraArgs/)

    const { root: rootProvider } = writeJsonConfig({
      cli: { gemini: { extraArgs: 'nope' } },
    })
    expect(() => loadSummarizeConfig({ env: { HOME: rootProvider } })).toThrow(
      /cli\.gemini\.extraArgs/
    )
  })
})

import { mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  normalizeDaemonPort,
  normalizeDaemonToken,
  readDaemonConfig,
  resolveDaemonConfigPath,
  writeDaemonConfig,
} from '../src/daemon/config.js'
import {
  DAEMON_CONFIG_DIR,
  DAEMON_CONFIG_FILENAME,
  DAEMON_PORT_DEFAULT,
} from '../src/daemon/constants.js'
import { buildEnvSnapshotFromEnv } from '../src/daemon/env-snapshot.js'

describe('daemon config', () => {
  it('resolves config path and errors without HOME', () => {
    expect(() => resolveDaemonConfigPath({})).toThrow(/Missing HOME/)
    expect(resolveDaemonConfigPath({ HOME: '/tmp' })).toBe(
      path.join('/tmp', DAEMON_CONFIG_DIR, DAEMON_CONFIG_FILENAME)
    )
  })

  it('normalizes token and port', () => {
    expect(() => normalizeDaemonToken('')).toThrow(/Missing token/)
    expect(() => normalizeDaemonToken('short-token')).toThrow(/Token too short/)
    expect(normalizeDaemonToken('  1234567890abcdef  ')).toBe('1234567890abcdef')

    expect(normalizeDaemonPort(undefined)).toBe(DAEMON_PORT_DEFAULT)
    expect(normalizeDaemonPort(3000.9)).toBe(3000)
    expect(() => normalizeDaemonPort(Number.NaN)).toThrow(/Invalid port/)
    expect(() => normalizeDaemonPort(0)).toThrow(/Invalid port/)
    expect(() => normalizeDaemonPort(70000)).toThrow(/Invalid port/)
  })

  it('reads missing/invalid config files', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'summarize-daemon-config-'))
    const env = { HOME: home }
    const configPath = resolveDaemonConfigPath(env)

    await expect(readDaemonConfig({ env })).resolves.toBeNull()

    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, 'not json', 'utf8')
    await expect(readDaemonConfig({ env })).rejects.toThrow(/Invalid daemon config JSON/)

    await fs.writeFile(configPath, JSON.stringify('nope'), 'utf8')
    await expect(readDaemonConfig({ env })).rejects.toThrow(/expected object/)
  })

  it('parses env snapshot and defaults installedAt', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'summarize-daemon-config-'))
    const env = { HOME: home }
    const configPath = resolveDaemonConfigPath(env)

    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        token: '1234567890abcdef',
        port: 9999,
        env: { OPENAI_API_KEY: '  key  ', PATH: '   ', FOO: 123 },
      }),
      'utf8'
    )

    const cfg = await readDaemonConfig({ env })
    expect(cfg?.version).toBe(1)
    expect(cfg?.token).toBe('1234567890abcdef')
    expect(cfg?.port).toBe(9999)
    expect(cfg?.env).toEqual({ OPENAI_API_KEY: 'key' })
    expect(typeof cfg?.installedAt).toBe('string')
  })

  it('writes config using normalized values', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'summarize-daemon-config-'))
    const env = { HOME: home }

    const writtenPath = await writeDaemonConfig({
      env,
      config: {
        token: '  1234567890abcdef  ',
        port: 2222.2,
        env: buildEnvSnapshotFromEnv({
          OPENAI_API_KEY: ' k ',
          PATH: '',
          SUMMARIZE_TRANSCRIBER: ' parakeet ',
          SUMMARIZE_ONNX_PARAKEET_CMD: ' run-parakeet {input} ',
          SUMMARIZE_ONNX_CANARY_CMD: ' run-canary {input}  ',
        }),
        installedAt: '2025-12-27T00:00:00.000Z',
      },
    })

    expect(writtenPath).toBe(resolveDaemonConfigPath(env))

    const parsed = JSON.parse(await fs.readFile(writtenPath, 'utf8')) as Record<string, unknown>
    expect(parsed.version).toBe(1)
    expect(parsed.token).toBe('1234567890abcdef')
    expect(parsed.port).toBe(2222)
    expect(parsed.installedAt).toBe('2025-12-27T00:00:00.000Z')
    expect(parsed.env).toEqual({
      OPENAI_API_KEY: 'k',
      SUMMARIZE_TRANSCRIBER: 'parakeet',
      SUMMARIZE_ONNX_PARAKEET_CMD: 'run-parakeet {input}',
      SUMMARIZE_ONNX_CANARY_CMD: 'run-canary {input}',
    })
  })
})

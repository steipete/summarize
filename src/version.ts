import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

declare const __dirname: string | undefined

export const FALLBACK_VERSION = '0.3.0'

export function resolvePackageVersion(importMetaUrl?: string): string {
  const injected =
    typeof process !== 'undefined' && typeof process.env.SUMMARIZE_VERSION === 'string'
      ? process.env.SUMMARIZE_VERSION.trim()
      : ''
  if (injected.length > 0) return injected

  const startDir = (() => {
    if (typeof importMetaUrl === 'string' && importMetaUrl.trim().length > 0) {
      try {
        return path.dirname(fileURLToPath(importMetaUrl))
      } catch {
        // ignore
      }
    }

    if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname

    return process.cwd()
  })()
  let dir = startDir

  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(dir, 'package.json')
    try {
      const raw = fs.readFileSync(candidate, 'utf8')
      const json = JSON.parse(raw) as { version?: unknown } | null
      if (json && typeof json.version === 'string' && json.version.trim().length > 0) {
        return json.version.trim()
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return FALLBACK_VERSION
}

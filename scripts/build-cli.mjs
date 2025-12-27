import { execSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

const distDir = path.join(repoRoot, 'dist')
await mkdir(distDir, { recursive: true })

const gitSha = (() => {
  try {
    return execSync('git rev-parse --short=8 HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
})()

// ESM binary wrapper.
// Avoid bundling: CJS deps (e.g. commander) can trigger esbuild's dynamic-require shim in ESM output.
const wrapper = `#!/usr/bin/env node
${gitSha ? `if (!process.env.SUMMARIZE_GIT_SHA) process.env.SUMMARIZE_GIT_SHA = ${JSON.stringify(gitSha)}\n` : ''}await import('./esm/cli.js')
`

await writeFile(path.join(distDir, 'cli.js'), wrapper, 'utf8')

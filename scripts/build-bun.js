#!/usr/bin/env bun
//
// build-bun.js
// summarize
//

// Don't use Bun shell ($) as it breaks bytecode compilation.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const projectRoot = join(import.meta.dir, '..')
const distDir = join(projectRoot, 'dist-bun')
const require = createRequire(import.meta.url)

function run(cmd, args, opts = {}) {
  const printable = [cmd, ...args].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')
  console.log(`+ ${printable}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (result.status !== 0) {
    throw new Error(`${cmd} failed with exit code ${result.status}`)
  }
}

function readPackageVersion() {
  const pkg = require(join(projectRoot, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return null
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function chmodX(path) {
  run('chmod', ['+x', path])
}

function buildOne({ target, outName }) {
  const outPath = join(distDir, outName)
  console.log(`\n🔨 Building ${outName} (target=${target}, bytecode)…`)
  run('bun', [
    'build',
    join(projectRoot, 'src/cli.ts'),
    '--compile',
    '--bytecode',
    '--minify',
    '--target',
    target,
    '--outfile',
    outPath,
  ])
  chmodX(outPath)

  try {
    const st = statSync(outPath)
    const size = fmtSize(st.size)
    console.log(`✅ Built ${outName}${size ? ` (${size})` : ''}`)
  } catch {
    console.log(`✅ Built ${outName}`)
  }

  return outPath
}

function buildMacosArm64({ version }) {
  const outPath = buildOne({ target: 'bun-darwin-arm64', outName: 'summarize' })
  chmodX(outPath)

  const tarName = `summarize-macos-arm64-v${version}.tar.gz`
  const tarPath = join(distDir, tarName)
  console.log('\n📦 Packaging tarball…')
  run('tar', ['-czf', tarPath, '-C', distDir, 'summarize'])

  console.log('\n🔐 sha256:')
  run('shasum', ['-a', '256', tarPath])

  return { binary: outPath, tarPath }
}

function main() {
  console.log('🚀 summarize Bun builder')
  console.log('========================')

  const version = readPackageVersion()

  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true })
  }

  const { binary } = buildMacosArm64({ version })

  if (process.argv.includes('--test')) {
    console.log('\n🧪 Smoke…')
    run(binary, ['--version'])
    run(binary, ['--help'])
  }

  console.log(`\n✨ Done. dist: ${distDir}`)
}

// Performance knobs for bun compile (matches poltergeist pattern).
process.env.BUN_JSC_forceRAMSize = '1073741824'
process.env.BUN_JSC_useJIT = '1'
process.env.BUN_JSC_useBBQJIT = '1'
process.env.BUN_JSC_useDFGJIT = '1'
process.env.BUN_JSC_useFTLJIT = '1'

main()

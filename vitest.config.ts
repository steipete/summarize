import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@steipete\/summarize-core\/content$/,
        replacement: resolve(rootDir, 'packages/core/src/content/index.ts'),
      },
      {
        find: /^@steipete\/summarize-core\/prompts$/,
        replacement: resolve(rootDir, 'packages/core/src/prompts/index.ts'),
      },
      {
        find: /^@steipete\/summarize-core\/language$/,
        replacement: resolve(rootDir, 'packages/core/src/language.ts'),
      },
      {
        find: /^@steipete\/summarize-core$/,
        replacement: resolve(rootDir, 'packages/core/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/dist/**',
        '**/node_modules/**',
        'tests/**',
        // Barrels / type-only entrypoints (noise for coverage).
        'src/**/index.ts',
        'src/**/types.ts',
        'src/**/deps.ts',
      ],
      thresholds: {
        branches: 75,
        functions: 75,
        lines: 75,
        statements: 75,
      },
    },
  },
})

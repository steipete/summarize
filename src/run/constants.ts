import type { ModelConfig } from '../config.js'

export const BIRD_TIP = ''
export const UVX_TIP =
  'Tip: Install uv (uvx) for local Markdown conversion: brew install uv (or set UVX_PATH to your uvx binary).'
export const SUPPORT_URL = 'https://github.com/steipete/summarize'
export const TWITTER_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com'])
export const MAX_TEXT_BYTES_DEFAULT = 10 * 1024 * 1024

export const BUILTIN_MODELS: Record<string, ModelConfig> = {
  free: {
    mode: 'auto',
    rules: [
      {
        candidates: [
          // Snapshot (2025-12-23): generated via `summarize refresh-free`.
          'openrouter/xiaomi/mimo-v2-flash:free',
          'openrouter/mistralai/devstral-2512:free',
          'openrouter/qwen/qwen3-coder:free',
          'openrouter/kwaipilot/kat-coder-pro:free',
          'openrouter/moonshotai/kimi-k2:free',
          'openrouter/nex-agi/deepseek-v3.1-nex-n1:free',
        ],
      },
    ],
  },
}

export const VERBOSE_PREFIX = '[summarize]'

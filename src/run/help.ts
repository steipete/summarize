import { Command, Option } from 'commander'
import { SUPPORT_URL } from './constants.js'
import { ansi, supportsColor } from './terminal.js'

export function buildProgram() {
  return new Command()
    .name('summarize')
    .description('Summarize web pages and YouTube links (uses direct provider API keys).')
    .argument('[input]', 'URL or local file path to summarize')
    .option(
      '--youtube <mode>',
      'YouTube transcript source: auto, web, no-auto (skip auto-generated captions), yt-dlp, apify',
      'auto'
    )
    .addOption(
      new Option(
        '--transcriber <name>',
        'Audio transcription backend: whisper (default), parakeet, canary'
      )
        .choices(['whisper', 'parakeet', 'canary'])
        .default('whisper')
    )
    .addOption(
      new Option(
        '--video-mode <mode>',
        'Video handling: auto (prefer video understanding if supported), transcript, understand.'
      )
        .choices(['auto', 'transcript', 'understand'])
        .default('auto')
    )
    .option('--timestamps', 'Include timestamps in transcripts when available.', false)
    .option(
      '--firecrawl <mode>',
      'Firecrawl usage: off, auto (fallback), always (try Firecrawl first).',
      'auto'
    )
    .option(
      '--format <format>',
      'Website/file content format: md|text. For websites: controls the extraction format. For files: controls whether we try to preprocess to Markdown for model compatibility. (default: text; default in --extract mode for URLs: md)',
      undefined
    )
    .addOption(
      new Option(
        '--preprocess <mode>',
        'Preprocess inputs for model compatibility: off, auto (fallback), always.'
      )
        .choices(['off', 'auto', 'always'])
        .default('auto')
    )
    .addOption(
      new Option(
        '--markdown-mode <mode>',
        'Markdown conversion: off, auto, llm (force LLM), readability. For websites: converts HTML→Markdown. For YouTube/transcripts: llm mode formats raw transcripts into clean markdown with headings and paragraphs.'
      ).default('readability')
    )
    .addOption(
      new Option(
        '--markdown <mode>',
        'Deprecated alias for --markdown-mode (use --extract --format md --markdown-mode ...)'
      ).hideHelp()
    )
    .option(
      '--length <length>',
      'Summary length: short|medium|long|xl|xxl (or s/m/l) or a character limit like 20000, 20k',
      'xl'
    )
    .option(
      '--language, --lang <language>',
      'Output language: auto (match source), en, de, english, german, ... (default: auto; configurable in ~/.summarize/config.json via output.language)',
      undefined
    )
    .option(
      '--max-output-tokens <count>',
      'Hard cap for LLM output tokens (e.g. 2000, 2k). Overrides provider defaults.',
      undefined
    )
    .option(
      '--timeout <duration>',
      'Timeout for content fetching and LLM request: 30 (seconds), 30s, 2m, 5000ms',
      '2m'
    )
    .option('--retries <count>', 'LLM retry attempts on timeout (default: 1).', '1')
    .option(
      '--model <model>',
      'LLM model id: auto, <name>, cli/<provider>/<model>, xai/..., openai/..., google/..., anthropic/..., zai/... or openrouter/<author>/<slug> (default: auto)',
      undefined
    )
    .option(
      '--prompt <text>',
      'Override the summary prompt (instruction prefix; context/content still appended).',
      undefined
    )
    .option('--prompt-file <path>', 'Read the prompt override from a file.', undefined)
    .option('--no-cache', 'Bypass cache reads and writes.')
    .option('--cache-stats', 'Print cache stats and exit.')
    .option('--clear-cache', 'Delete the cache database and exit.', false)
    .addOption(
      new Option(
        '--cli [provider]',
        'Use a CLI provider: claude, gemini, codex (equivalent to --model cli/<provider>). If omitted, use auto selection with CLI enabled.'
      )
    )
    .option('--extract', 'Print extracted content and exit (no LLM summary)', false)
    .addOption(new Option('--extract-only', 'Deprecated alias for --extract').hideHelp())
    .option('--json', 'Output structured JSON (includes prompt + metrics)', false)
    .option(
      '--stream <mode>',
      'Stream LLM output: auto (TTY only), on, off. Note: streaming is disabled in --json mode.',
      'auto'
    )
    .option('--plain', 'Keep raw text/markdown output (no ANSI/OSC rendering)', false)
    .option('--no-color', 'Disable ANSI colors in output', false)
    .option('--verbose', 'Print detailed progress info to stderr', false)
    .option('--debug', 'Alias for --verbose (and defaults --metrics to detailed)', false)
    .addOption(
      new Option('--metrics <mode>', 'Metrics output: off, on, detailed')
        .choices(['off', 'on', 'detailed'])
        .default('on')
    )
    .option('-V, --version', 'Print version and exit', false)
    .allowExcessArguments(false)
}

export function attachRichHelp(
  program: Command,
  env: Record<string, string | undefined>,
  stdout: NodeJS.WritableStream
) {
  const color = supportsColor(stdout, env)
  const heading = (text: string) => ansi('1;36', text, color)
  const cmd = (text: string) => ansi('1', text, color)
  const dim = (text: string) => ansi('2', text, color)

  program.addHelpText(
    'after',
    () => `
${heading('Examples')}
  ${cmd('summarize "https://example.com"')}
  ${cmd('summarize "https://example.com" --extract')} ${dim('# extracted plain text')}
  ${cmd('summarize "https://example.com" --extract --format md')} ${dim('# extracted markdown (prefers Firecrawl when configured)')}
  ${cmd('summarize "https://example.com" --extract --format md --markdown-mode llm')} ${dim('# extracted markdown via LLM')}
  ${cmd('summarize "https://www.youtube.com/watch?v=..." --extract --format md --markdown-mode llm')} ${dim('# transcript as formatted markdown')}
  ${cmd('summarize "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s" --extract --youtube web')}
  ${cmd('summarize "https://example.com" --length 20k --max-output-tokens 2k --timeout 2m --model openai/gpt-5-mini')}
  ${cmd('summarize "https://example.com" --model mymodel')} ${dim('# config preset')}
  ${cmd('summarize "https://example.com" --json --verbose')}

${heading('Env Vars')}
  XAI_API_KEY           optional (required for xai/... models)
  XAI_BASE_URL          optional (override xAI API endpoint)
  OPENAI_API_KEY        optional (required for openai/... models)
  OPENAI_BASE_URL       optional (OpenAI-compatible API endpoint; e.g. OpenRouter)
  OPENAI_USE_CHAT_COMPLETIONS optional (force OpenAI chat completions)
  OPENROUTER_API_KEY    optional (routes openai/... models through OpenRouter)
  Z_AI_API_KEY          optional (required for zai/... models)
  Z_AI_BASE_URL         optional (override default Z.AI base URL)
  GEMINI_API_KEY        optional (required for google/... models)
  GOOGLE_BASE_URL       optional (override Google API endpoint; alias: GEMINI_BASE_URL)
  ANTHROPIC_API_KEY     optional (required for anthropic/... models)
  ANTHROPIC_BASE_URL    optional (override Anthropic API endpoint)
  CLAUDE_PATH           optional (path to Claude CLI binary)
  CODEX_PATH            optional (path to Codex CLI binary)
  GEMINI_PATH           optional (path to Gemini CLI binary)
  SUMMARIZE_MODEL       optional (overrides default model selection)
  FIRECRAWL_API_KEY     optional website extraction fallback (Markdown)
  APIFY_API_TOKEN       optional YouTube transcript fallback
  SUMMARIZE_TRANSCRIBER optional (whisper, parakeet, canary)
  SUMMARIZE_ONNX_PARAKEET_CMD optional (command to run Parakeet ONNX transcription; use {input} placeholder)
  SUMMARIZE_ONNX_CANARY_CMD optional (command to run Canary ONNX transcription; use {input} placeholder)
  YT_DLP_PATH           optional path to yt-dlp binary for audio extraction
  FAL_KEY               optional FAL AI API key for audio transcription

${heading('Support')}
  ${SUPPORT_URL}
`
  )
}

export function buildConciseHelp(): string {
  return [
    'summarize - Summarize web pages, files, and YouTube links.',
    '',
    'Usage: summarize <url-or-file> [flags]',
    '',
    'Examples:',
    '  summarize "https://example.com"',
    '  summarize "/path/to/file.pdf" --model google/gemini-3-flash-preview',
    '',
    'Run summarize --help for full options.',
    `Support: ${SUPPORT_URL}`,
  ].join('\n')
}

export function buildRefreshFreeHelp(): string {
  return [
    'Usage: summarize refresh-free [--runs 2] [--smart 3] [--min-params 27b] [--max-age-days 180] [--set-default] [--verbose]',
    '',
    'Writes ~/.summarize/config.json (models.free) with working OpenRouter :free candidates.',
    'With --set-default: also sets `model` to "free".',
  ].join('\n')
}

export function buildDaemonHelp(): string {
  return [
    'Usage: summarize daemon <command> [options]',
    '',
    'Commands:',
    '  install   Install/upgrade the daemon autostart service and write ~/.summarize/daemon.json',
    '  restart   Restart the daemon autostart service',
    '  status    Check daemon service + daemon health',
    '  uninstall Unload autostart service (macOS moves plist to Trash)',
    '  run       Run the daemon in the foreground (used by autostart)',
    '',
    'Notes:',
    '  macOS: LaunchAgent (launchd)',
    '  Linux: systemd user service',
    '  Windows: Scheduled Task',
    '',
    'Options:',
    '  --dev            Install service that runs src/cli.ts via tsx (repo dev mode)',
    '  --port <n>       (default: 8787)',
    '  --token <token>  (required for install)',
  ].join('\n')
}

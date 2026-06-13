# Fish completions for summarize (steipete/summarize)

set -g __summarize_commands help slides status refresh-free daemon transcriber
set -g __summarize_themes aurora ember moss mono

function __summarize_needs_subcommand
    set -l tokens (commandline -opc)
    test (count $tokens) -lt 2
end

function __summarize_no_subcommand
    set -l tokens (commandline -opc)
    if test (count $tokens) -lt 2
        return 0
    end
    not contains -- $tokens[2] $__summarize_commands
end

function __summarize_command_is
    set -l tokens (commandline -opc)
    test (count $tokens) -ge 2
    or return 1
    test "$tokens[2]" = "$argv[1]"
end

function __summarize_needs_child_command
    set -l parent "$argv[1]"
    set -e argv[1]
    set -l tokens (commandline -opc)
    test (count $tokens) -ge 2
    and test "$tokens[2]" = "$parent"
    or return 1
    if test (count $tokens) -eq 2
        return 0
    end
    test (count $tokens) -eq 3
    and not contains -- $tokens[3] $argv
end

function __summarize_nested_command_is
    set -l tokens (commandline -opc)
    test (count $tokens) -ge 3
    or return 1
    test "$tokens[2]" = "$argv[1]"
    and test "$tokens[3]" = "$argv[2]"
end

for cmd in summarize summarizer
    complete -c $cmd -n '__summarize_needs_subcommand' -xa "$__summarize_commands" -d 'Subcommand'

    # YouTube and media options
    complete -c $cmd -n '__summarize_no_subcommand' -l youtube -d 'YouTube transcript source' -xa 'auto web no-auto yt-dlp apify'
    complete -c $cmd -n '__summarize_no_subcommand' -l transcriber -d 'Audio transcription backend' -xa 'auto whisper parakeet canary'
    complete -c $cmd -n '__summarize_no_subcommand' -l diarize -d 'Add speaker labels' -xa 'auto elevenlabs openai'
    complete -c $cmd -n '__summarize_no_subcommand' -l identify-speakers -d 'Resolve diarization labels to real names'
    complete -c $cmd -n '__summarize_no_subcommand' -l no-identify-speakers -d 'Keep generic diarization labels'
    complete -c $cmd -n '__summarize_no_subcommand' -l speaker-profile -d 'Speaker profile name' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l speaker-at -d 'Timestamp speaker anchor' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l remember-speakers -d 'Persist resolved speaker mappings'
    complete -c $cmd -n '__summarize_no_subcommand' -l video-mode -d 'Video handling mode' -xa 'auto transcript understand'
    complete -c $cmd -n '__summarize_no_subcommand' -l embedded-video -d 'Embedded YouTube handling' -xa 'auto off prefer both'

    # Slides options
    complete -c $cmd -n '__summarize_no_subcommand' -l slides -d 'Extract slides for video URLs' -xa 'true false yes no on off 1 0'
    complete -c $cmd -n '__summarize_no_subcommand' -l slides-debug -d 'Show slide image paths'
    complete -c $cmd -n '__summarize_no_subcommand' -l slides-ocr -d 'Run OCR on extracted slides'
    complete -c $cmd -n '__summarize_no_subcommand' -l slides-dir -d 'Base output dir for slides' -rF
    complete -c $cmd -n '__summarize_no_subcommand' -l slides-scene-threshold -d 'Scene detection threshold (0.1-1.0)' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l slides-max -d 'Maximum slides to extract' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l slides-min-duration -d 'Minimum seconds between slides' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l timestamps -d 'Include timestamps in transcripts'

    # Content options
    complete -c $cmd -n '__summarize_no_subcommand' -l firecrawl -d 'Firecrawl usage' -xa 'off auto always'
    complete -c $cmd -n '__summarize_no_subcommand' -l format -d 'Content format' -xa 'md markdown text plain'
    complete -c $cmd -n '__summarize_no_subcommand' -l preprocess -d 'Preprocess inputs' -xa 'off auto always'
    complete -c $cmd -n '__summarize_no_subcommand' -l markdown-mode -d 'Markdown conversion mode' -xa 'off auto llm readability'

    # Summary options
    complete -c $cmd -n '__summarize_no_subcommand' -l length -d 'Summary length' -xa 'short s medium m long l xl xxl'
    complete -c $cmd -n '__summarize_no_subcommand' -l max-extract-characters -d 'Max characters in --extract' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l language -l lang -d 'Output language' -xa 'auto en de english german'
    complete -c $cmd -n '__summarize_no_subcommand' -l max-output-tokens -d 'Hard cap for LLM output tokens' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l force-summary -d 'Force LLM summary even for short content'
    complete -c $cmd -n '__summarize_no_subcommand' -l timeout -d 'Timeout for fetching/LLM' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l retries -d 'LLM retry attempts on timeout' -x

    # Model options
    complete -c $cmd -n '__summarize_no_subcommand' -l model -d 'LLM model id' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l cli -d 'Use CLI provider' -xa 'claude gemini codex agent openclaw opencode copilot agy pi'
    complete -c $cmd -n '__summarize_no_subcommand' -l fast -d 'Use OpenAI fast service tier'
    complete -c $cmd -n '__summarize_no_subcommand' -l service-tier -d 'OpenAI service tier' -xa 'default fast priority flex'
    complete -c $cmd -n '__summarize_no_subcommand' -l thinking -d 'OpenAI reasoning effort' -xa 'none low medium high xhigh off min mid'
    complete -c $cmd -n '__summarize_no_subcommand' -l prompt -d 'Override summary prompt' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l prompt-file -d 'Read prompt from file' -rF

    # Cache options
    complete -c $cmd -n '__summarize_no_subcommand' -l no-cache -d 'Bypass summary cache'
    complete -c $cmd -n '__summarize_no_subcommand' -l no-media-cache -d 'Disable media download cache'
    complete -c $cmd -n '__summarize_no_subcommand' -l cache-stats -d 'Print cache stats and exit'
    complete -c $cmd -n '__summarize_no_subcommand' -l clear-cache -d 'Delete cache database and exit'

    # Output options
    complete -c $cmd -n '__summarize_no_subcommand' -l extract -d 'Print extracted content'
    complete -c $cmd -n '__summarize_no_subcommand' -l json -d 'Output structured JSON'
    complete -c $cmd -n '__summarize_no_subcommand' -l stream -d 'Stream LLM output' -xa 'auto on off'
    complete -c $cmd -n '__summarize_no_subcommand' -l width -d 'Override terminal width' -x
    complete -c $cmd -n '__summarize_no_subcommand' -l plain -d 'Keep raw text/markdown'
    complete -c $cmd -n '__summarize_no_subcommand' -l no-color -d 'Disable ANSI colors'
    complete -c $cmd -n '__summarize_no_subcommand' -l theme -d 'CLI theme' -xa "$__summarize_themes"

    # Debug/info
    complete -c $cmd -n '__summarize_no_subcommand' -l verbose -d 'Print detailed progress to stderr'
    complete -c $cmd -n '__summarize_no_subcommand' -l debug -d 'Alias for --verbose'
    complete -c $cmd -n '__summarize_no_subcommand' -l metrics -d 'Metrics output' -xa 'off on detailed'
    complete -c $cmd -n '__summarize_no_subcommand' -s V -l version -d 'Print version and exit'
    complete -c $cmd -s h -l help -d 'Display help'

    # help topics
    complete -c $cmd -n '__summarize_needs_child_command help help slides status refresh-free daemon transcriber' -xa "$__summarize_commands" -d 'Help topic'

    # slides subcommand
    complete -c $cmd -n '__summarize_command_is slides' -l slides-ocr -d 'Run OCR on extracted slides'
    complete -c $cmd -n '__summarize_command_is slides' -l slides-dir -d 'Base output dir for slides' -rF
    complete -c $cmd -n '__summarize_command_is slides' -s o -l output -d 'Alias for --slides-dir' -rF
    complete -c $cmd -n '__summarize_command_is slides' -l slides-scene-threshold -d 'Scene detection threshold (0.1-1.0)' -x
    complete -c $cmd -n '__summarize_command_is slides' -l slides-max -d 'Maximum slides to extract' -x
    complete -c $cmd -n '__summarize_command_is slides' -l slides-min-duration -d 'Minimum seconds between slides' -x
    complete -c $cmd -n '__summarize_command_is slides' -l render -d 'Inline render mode' -xa 'auto kitty iterm none'
    complete -c $cmd -n '__summarize_command_is slides' -l theme -d 'CLI theme' -xa "$__summarize_themes"
    complete -c $cmd -n '__summarize_command_is slides' -l timeout -d 'Timeout for video extraction' -x
    complete -c $cmd -n '__summarize_command_is slides' -l no-cache -d 'Bypass slide cache'
    complete -c $cmd -n '__summarize_command_is slides' -l json -d 'Output JSON payload'
    complete -c $cmd -n '__summarize_command_is slides' -l verbose -d 'Print detailed progress to stderr'
    complete -c $cmd -n '__summarize_command_is slides' -l debug -d 'Alias for --verbose'
    complete -c $cmd -n '__summarize_command_is slides' -s V -l version -d 'Print version and exit'

    # status subcommand
    complete -c $cmd -n '__summarize_command_is status' -l json -d 'Output structured JSON'
    complete -c $cmd -n '__summarize_command_is status' -l probe -d 'Probe model-list endpoints'
    complete -c $cmd -n '__summarize_command_is status' -l verbose -d 'Include detailed status'
    complete -c $cmd -n '__summarize_command_is status' -l no-color -d 'Disable ANSI colors'

    # refresh-free subcommand
    complete -c $cmd -n '__summarize_command_is refresh-free' -l runs -d 'Smoke-test runs per model' -x
    complete -c $cmd -n '__summarize_command_is refresh-free' -l smart -d 'Smart benchmark runs' -x
    complete -c $cmd -n '__summarize_command_is refresh-free' -l min-params -d 'Minimum parameter size' -x
    complete -c $cmd -n '__summarize_command_is refresh-free' -l max-age-days -d 'Maximum model age in days' -x
    complete -c $cmd -n '__summarize_command_is refresh-free' -l set-default -d 'Set free preset as default'
    complete -c $cmd -n '__summarize_command_is refresh-free' -l verbose -d 'Print detailed progress'

    # daemon subcommand
    complete -c $cmd -n '__summarize_needs_child_command daemon install restart status uninstall run' -xa 'install restart status uninstall run' -d 'Daemon command'
    complete -c $cmd -n '__summarize_nested_command_is daemon install' -l dev -d 'Install dev-mode daemon'
    complete -c $cmd -n '__summarize_nested_command_is daemon install; or __summarize_nested_command_is daemon run' -l port -d 'Daemon port' -x
    complete -c $cmd -n '__summarize_nested_command_is daemon install; or __summarize_nested_command_is daemon run' -l token -d 'Daemon auth token' -x

    # transcriber subcommand
    complete -c $cmd -n '__summarize_needs_child_command transcriber setup' -xa 'setup' -d 'Transcriber command'
    complete -c $cmd -n '__summarize_nested_command_is transcriber setup' -l model -d 'ONNX transcription model' -xa 'parakeet canary'
    complete -c $cmd -n '__summarize_nested_command_is transcriber setup' -l theme -d 'CLI theme' -xa "$__summarize_themes"
end

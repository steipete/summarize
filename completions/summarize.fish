# Completions for summarize (steipete/summarize)

# YouTube options
complete -c summarize -l youtube -d 'YouTube transcript source' -xa 'auto web no-auto yt-dlp apify'
complete -c summarize -l transcriber -d 'Audio transcription backend' -xa 'auto whisper parakeet canary'
complete -c summarize -l video-mode -d 'Video handling mode' -xa 'auto transcript understand'

# Slides options
complete -c summarize -l slides -d 'Extract slides for video URLs'
complete -c summarize -l slides-debug -d 'Show slide image paths'
complete -c summarize -l slides-ocr -d 'Run OCR on extracted slides'
complete -c summarize -l slides-dir -d 'Base output dir for slides' -rF
complete -c summarize -l slides-scene-threshold -d 'Scene detection threshold (0.1-1.0)' -x
complete -c summarize -l slides-max -d 'Maximum slides to extract' -x
complete -c summarize -l slides-min-duration -d 'Minimum seconds between slides' -x
complete -c summarize -l timestamps -d 'Include timestamps in transcripts'

# Content options
complete -c summarize -l firecrawl -d 'Firecrawl usage' -xa 'off auto always'
complete -c summarize -l format -d 'Content format' -xa 'md text'
complete -c summarize -l preprocess -d 'Preprocess inputs' -xa 'off auto always'
complete -c summarize -l markdown-mode -d 'Markdown conversion mode' -xa 'off auto llm readability'

# Summary options
complete -c summarize -l length -d 'Summary length' -xa 'short s medium m long l xl xxl'
complete -c summarize -l max-extract-characters -d 'Max characters in --extract' -x
complete -c summarize -l language -l lang -d 'Output language' -xa 'auto en de english german'
complete -c summarize -l max-output-tokens -d 'Hard cap for LLM output tokens' -x
complete -c summarize -l force-summary -d 'Force LLM summary even for short content'
complete -c summarize -l timeout -d 'Timeout for fetching/LLM (e.g. 30s, 2m)' -x
complete -c summarize -l retries -d 'LLM retry attempts on timeout' -x

# Model options
complete -c summarize -l model -d 'LLM model id' -x
complete -c summarize -l cli -d 'Use CLI provider' -xa 'claude gemini codex agent'
complete -c summarize -l prompt -d 'Override summary prompt' -x
complete -c summarize -l prompt-file -d 'Read prompt from file' -rF

# Cache options
complete -c summarize -l no-cache -d 'Bypass summary cache'
complete -c summarize -l no-media-cache -d 'Disable media download cache'
complete -c summarize -l cache-stats -d 'Print cache stats and exit'
complete -c summarize -l clear-cache -d 'Delete cache database and exit'

# Output options
complete -c summarize -l extract -d 'Print extracted content (no LLM)'
complete -c summarize -l json -d 'Output structured JSON'
complete -c summarize -l stream -d 'Stream LLM output' -xa 'auto on off'
complete -c summarize -l plain -d 'Keep raw text/markdown (no ANSI)'
complete -c summarize -l no-color -d 'Disable ANSI colors'
complete -c summarize -l theme -d 'CLI theme' -xa 'aurora ember moss mono'

# Debug/info
complete -c summarize -l verbose -d 'Print detailed progress to stderr'
complete -c summarize -l debug -d 'Alias for --verbose'
complete -c summarize -l metrics -d 'Metrics output' -xa 'off on detailed'
complete -c summarize -s V -l version -d 'Print version and exit'
complete -c summarize -s h -l help -d 'Display help'

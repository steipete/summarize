# Changelog

## 0.18.1 - Unreleased

### Fixes

- Media cache: persist TTL pruning to the index after an expired-entry miss.
- Media cache: serialize index updates across concurrent daemon and CLI processes to prevent failed writes, lost entries, and orphaned files.
- Daemon chat: cancel CLI-backed agent processes when their HTTP client disconnects.
- Chrome extension: restore persisted chat history after the daemon agent-route refactor.
- CLI extraction: honor `--max-extract-characters` for remote text and document assets, not only web-page extraction.
- Cache: wait for concurrent first-open SQLite locks before enabling WAL instead of failing CLI startup with `database is locked`.
- Slides: honor explicit and configured scene thresholds without silently replacing them through auto-tuning.
- Slides: report the calibrated scene threshold in JSON and `slides.json` when interval fallback supplies frames after zero scene detections.
- Slides: render extracted slide labels or debug paths for `--slides --extract` even when a direct video has no transcript.
- CLI errors: print Commander validation failures and missing-input help once instead of duplicating them across stdout/stderr.
- Shell completions: sync and package Fish completions for both CLI aliases and subcommands, with candidate values matched to accepted CLI choices (#277, thanks @vincent-peng).
- Daemon: close live summarize and slide SSE connections immediately after terminal events instead of retaining them until session cleanup.
- Browser extension: declare User Scripts permissions per browser, route Chrome users to the required extension toggle, remove an invalid manifest permission, and align documented browser minimums.
- CLI video summaries: restore terminal and JSON output when direct video understanding delegates URL handling to the asset summarizer.
- Chrome extension: reject YouTube caption and transcript-panel results when the tab navigates to another video during extraction.
- Development CLI: load core workspace TypeScript sources directly for `pnpm summarize` and `pnpm s`, avoiding stale exports and concurrent rebuild races.
- Network safety: block private IPv4 targets embedded in the IPv4-translatable IPv6 prefix.
- Slides: ignore invalid zero-index slide markers without hanging while extracting slide references.
- Summary length: use `long` as the built-in default across the CLI, daemon, and Chrome extension; explicit and configured lengths remain unchanged.
- YouTube captions: ignore WebVTT header metadata, cue identifiers, comments, styles, and regions when building transcripts.

## 0.18.0 - 2026-06-12

### Features

- Website media: detect a primary embedded YouTube video, use free captions automatically, and combine its transcript with substantial article text; add `--embedded-video auto|off|prefer|both`.
- CLI status: add `summarize status` with positive-only model/provider discovery, structured JSON, verbose details, and optional non-inference endpoint probes.

### Fixes

- Chrome extension: transcribe direct MP3/MP4 URLs without probing page media, cancel summary and chat work when panel sessions close, and clear daemon retry timers after failed requests.
- Codex CLI: pin bare and auto-fallback runs to GPT-5.5 instead of inheriting an older runtime default.
- Direct media: classify audio and video URLs from the pathname only so media-looking query strings and fragments do not reroute normal pages.
- Network fetches: keep body-consumption deadlines active alongside caller cancellation and preserve caller abort reasons instead of misreporting them as timeouts.
- URL fetch guard: block IPv4 documentation ranges while allowing public addresses elsewhere in 192.0.0.0/8.
- YouTube metadata: harden view-count freshness, fallbacks, embedded transcript cache identity, and timeout enforcement while reading response bodies.
- Chrome extension: update Transformers.js to 4.2 and resolve its bundled ONNX runtime assets through the installed dependency graph.

### Docs

- Contributing: add repository setup, checks, and pull-request guidance (thanks @zichen0116).

## 0.17.3 - 2026-06-11

### Features

- YouTube transcripts: include a timestamped public view count in structured extraction results and human transcript output, with a one-hour extraction cache window for mutable metrics.

### Fixes

- Diarization: extract local video audio once before upload and reuse the compact mono MP3 across ElevenLabs/OpenAI fallbacks instead of sending the full video container.
- YouTube diarization: download audio only unless slides are also requested; combined slide/diarization runs fetch separate audio and video streams once, reuse the video for slide extraction, and keep slide-only cache entries from replacing transcript audio.
- ElevenLabs diarization: let the configured ten-minute transcription deadline govern long recordings instead of Undici’s hidden five-minute response-header timeout.
- OpenAI diarization: split long recordings into bounded chunks with isolated speaker labels, timestamp offsets, rate-limit-aware retries, and automatic temporary-file cleanup.
- Speaker identification: preserve fair bounded evidence for long or malformed diarization turns, use model-compatible OpenAI options, and keep usage-less paid calls from reporting a false `$0` estimate.
- HTML extraction: normalize LinkeDOM HTML attribute names case-insensitively while preserving case-sensitive SVG and MathML attributes.

## 0.17.2 - 2026-06-11

### Features

- CLI media: allow `--diarize` and speaker identification for local and direct audio/video inputs, including MP3 and MP4, instead of limiting speaker-labelled transcription to YouTube.
- YouTube transcripts: fall back to Android VR direct audio resolution and configured transcription when `yt-dlp` is missing or fails, while preserving explicit `--youtube yt-dlp` and diarization requirements.
- Chrome extension: transcribe captionless YouTube videos without the daemon using active-player/watch-page or Android VR direct audio, captured SABR fallback, MediaBunny/WebCodecs, and browser-cached multilingual Whisper Tiny.
- Chrome extension: transcribe fetchable direct and embedded media without the daemon using ranged MediaBunny/WebCodecs decoding, bounded audio chunks, and an idle-evictable browser Whisper runtime.

### Fixes

- Chrome extension: cancel pending summary starts when switching tabs and recover from stalled WebGPU Whisper initialization with a bounded CPU fallback.
- CLI: use the Codex runtime default model instead of pinning auto fallback to an obsolete model.
- Daemon: defer cache shutdown until in-flight summary work drains, preventing late writes through finalized SQLite statements.
- Dependencies: replace Ora, tslog, and the FAL SDK with focused local implementations while retaining spinner, daemon logging, retry, multipart upload, and FAL transcription behavior.
- Chrome extension: replace the bundled browser FFmpeg WebAssembly runtime with MediaBunny and native WebCodecs, adding AV1 frame extraction while reducing the packaged extension size.
- Chrome extension: avoid throttled offscreen canvas blob callbacks so MediaBunny slide JPEGs encode in milliseconds instead of roughly one second per frame.
- YouTube media: prefer direct audio already exposed by the active player or watch page before requesting Android VR media, with resolver and browser decoder diagnostics in extension logs.
- Extension tests: load the Firefox build through Mozilla `web-ext` in CI and run daily live YouTube resolver plus daemonless Chrome transcription checks.

## 0.17.1 - 2026-06-11

### Fixes

- Pi CLI: pass summary prompts through private temporary file attachments because current Pi print mode does not read stdin.
- Dependencies: update Markdansi to 0.3.1 and refresh the dependency lockfile.
- Release: allow exact-version smoke tests to bypass the minimum release age for freshly published packages.

## 0.17.0 - 2026-06-11

### Features

- LLM providers: add native MiniMax models via the OpenAI-compatible API, keeping reasoning separate from summary text in streaming and non-streaming calls (#250, thanks @neeravmakwana).
- CLI providers: add pi CLI as `--cli pi` / `--model cli/pi`, with JSON-mode parsing, stdin prompts, configurable binary/model, and daemon/Chrome model picker support (#247, thanks @Youpen-y).
- Add Antigravity CLI (`agy`) as a supported CLI provider. (#231, thanks @yetmike)
- CLI media: bundle an LGPL FFmpeg WebAssembly fallback for slide extraction and transcoding when native `ffmpeg`/`ffprobe` are unavailable, while continuing to prefer native tools.
- Chrome extension: add a Browser slide runtime with bundled FFmpeg WebAssembly for daemonless video extraction, while keeping Daemon as an optional faster runtime.
- Chrome extension: persist Browser-mode summaries, slide text, transcripts, and thumbnails in Chrome storage for 30 days, with Runtime settings showing cache status and a clear button.
- Add `--diarize [auto|elevenlabs|openai]` for speaker-labelled YouTube transcripts using ElevenLabs Scribe v2 or OpenAI `gpt-4o-transcribe-diarize`.
- Add verified speaker naming for diarized YouTube transcripts with timestamp anchors, reusable profiles, transcript-hash-guarded mappings, GPT-5.5 context inference, and atomic `--remember-speakers` config updates.

### Fixes

- CLI cache: derive summary content hashes from binary attachment bytes so repeated local image summaries can hit the cache (#244, thanks @alfozan).
- YouTube transcripts: let `--diarize auto` and matching explicit provider requests reuse the same compatible cached speaker-labelled transcript instead of re-transcribing the same video.
- Dependencies: enforce a seven-day minimum release age and replace Cheerio/JSDOM HTML parsing with LinkeDOM, reducing the CLI production closure by 47 packages while preserving extraction behavior.
- Dependencies: replace the oversized tokenizer package with a compact o200k-compatible implementation and remove Zag from Chrome extension controls.
- DNS-pinned fetches: bypass Node environment proxies so validated IP addresses cannot be replaced by proxy-side DNS resolution.
- CLI cache: include local media `fileMtime` when writing transcript cache entries so repeated unchanged audio/video extraction can hit cache (#240, #241, thanks @alfozan).
- CLI: pass Codex image attachments to `codex exec` so local image summaries no longer fail before starting (#242, #243, thanks @alfozan).
- OpenAI-compatible gateways: honor `OPENAI_USE_CHAT_COMPLETIONS=false` and `openai.useChatCompletions=false` so custom base URLs can use the Responses API (#235, #236, thanks @mzbgf).
- RSS transcripts: block feed-controlled transcript URLs that target loopback, private, link-local, reserved, or redirected local-network addresses (#239, thanks @Hinotoi-agent).
- Podcast transcripts: cap remote media downloads at 512 MB by default, with a finite opt-in override for larger files (#237, thanks @Hinotoi-agent).
- Anthropic: forward explicit CLI `--thinking` to Anthropic text and streaming requests without leaking persisted OpenAI thinking defaults into non-OpenAI providers (#233, thanks @wangwllu).
- Chrome extension: abort stale side-panel summary streams on tab changes so delayed output from a closed or replaced tab cannot render under the new page title.
- Core: extract video IDs from YouTube `/live/` URLs so live and premiere links no longer abort summarization (#232, thanks @devYRPauli).
- Chrome extension: keep YouTube slide cards on the shared slide-summary path so local browser thumbnails receive the same summary text shape as CLI `--slides`.

## 0.16.3 - 2026-05-22

### Fixes

- Daemon: coalesce duplicate active summarize requests so sidebar retries/reconnects reuse the same stream instead of racing slide summary state.

## 0.16.2 - 2026-05-22

### Fixes

- Chrome extension: preserve sidebar scroll position while streamed summaries rerender so loading updates do not jump readers back to the top.
- Slides: seed planned slide timelines from transcript duration so YouTube slide summaries can start streaming before video frame extraction finishes.
- Chrome extension: keep partial streamed slide-summary fragments from blocking the final summary, so YouTube slide cards replace transcript snippets with the same slide summaries the CLI renders.
- Chrome extension: render slide-summary intro text above gallery cards and remove the duplicate Slides count heading so sidebar slide output matches the CLI shape.
- Release: harden npm publishing so raw `npm publish` is blocked, packed manifests reject `workspace:*`, and releases publish to `next` before exact-version smoke promotes `latest`.

## 0.16.1 - 2026-05-21

### Fixes

- Packaging: publish the CLI with a resolved `@steipete/summarize-core` dependency after `0.16.0` was published with workspace metadata.

## 0.16.0 - 2026-05-21

### Features

- Add Ollama as a first-class provider (`ollama/<model>`). Uses Ollama's OpenAI-compatible endpoint (default `http://localhost:11434/v1`), no API key required, forces chat completions. Configurable via env `OLLAMA_BASE_URL` or config `ollama.baseUrl`. Daemon model picker auto-discovers Ollama models when `OLLAMA_BASE_URL` is set. See `docs/ollama.md`.

### Fixes

- CLI attachments: sanitize asset filenames before writing temp files so caller-supplied path components cannot escape the temp directory (#225, thanks @ejames-dev).
- CLI slides: keep local Ollama summaries from leaking planning text or malformed nested slide headings.
- Daemon: rate-limit repeated failed `/v1/*` bearer-token auth attempts with a bounded in-memory lockout (#227, thanks @ejames-dev).
- Daemon: use timing-safe bearer-token comparisons for local `/v1/*` authorization checks (#226, thanks @ejames-dev).
- Daemon: block daemon URL-mode extraction from fetching loopback, private-network, link-local, and redirect targets that resolve to local networks, and disable unguarded `yt-dlp` media fetches in guarded daemon URL runs.
- Chrome extension automation: require an extension-only native-input capability so page scripts cannot piggyback trusted input while automation is armed.
- Chrome extension: keep stale summarize stream starts from canceling newer streams after token lookup races.
- Chrome extension slides: request transcript context after restoring cached slides that do not include timed transcript text.
- Cache: clean generated slide artifacts when slide cache rows expire, evict, or clear.
- Release: align the release helper and docs with GitHub assets plus Homebrew/core verification instead of the retired tap flow.
- Daemon: cap concurrent summarize requests with an env-tunable limit so runaway extension/API clients receive a clear 429 instead of piling up background work.
- Chrome extension: allow max-size page extraction payloads to reach the daemon instead of failing JSON body parsing before summarization starts.
- CLI streaming: write interactive raw summary deltas as soon as they arrive instead of waiting for a newline before the first stdout output.
- Chrome extension: stream OpenAI GPT-5 summaries with fast/reasoning options instead of waiting for a blocking completion.
- Chrome extension: move the summary copy action into the header toolbar instead of reserving space above the rendered summary.
- Chrome extension automation: avoid duplicate content-script listeners when automation is injected more than once into the same tab.
- Chrome extension options: keep slower process-log responses from overwriting the logs for a newly selected process.
- Chrome extension: keep stale model discovery responses from reverting newer token results or user-selected models.
- Chrome extension options: keep stale daemon status checks from replacing the missing-token warning after the token field is cleared.
- Chrome extension options: show save failures instead of leaving the form stuck on Saving.
- CLI performance: skip remote asset probes for normal web URLs so extraction reaches first stdout sooner while preserving unknown-asset fallback after URL extraction failures.
- YouTube transcripts: try same-language caption fallbacks when the preferred caption URL is blocked or dead.
- Chrome extension: match CLI slide defaults for YouTube slide summaries and replace transcript fallback card text with LLM-written slide summaries.
- Chrome extension: render YouTube slide summaries through the shared CLI slide parser and coalesce duplicate slide summarize starts.
- Chrome extension options: defer loading automation skills until the Skills tab opens so settings startup avoids the large skills bundle.
- Chrome extension: make picker popovers opaque again and reorganize advanced options into clearer groups.
- Chrome extension options: avoid crashing when Chrome opens settings without the extension storage API available.

## 0.15.2 - 2026-05-17

### Fixes

- CLI streaming: fall back to non-streaming summaries when a stream iterator times out before yielding text, without marking slide streaming complete on failed partial output.
- Core prompts: escape untrusted prompt context/content delimiters and make sponsor-only slide instructions compatible with mandatory slide headings.
- Link preview: reject unsafe direct-video URL schemes, detect YouTube privacy-enhanced embeds, and avoid stripping visible inline text with similar CSS property/value prefixes.
- Slides: reject traversal and symlinked cache image paths while preserving valid child paths that start with dot-dot text.
- Chrome extension: flush final SSE events when streams close without a blank delimiter.
- Tests: include `packages/core/src` in coverage collection so core package regressions affect the gate.

## 0.15.1 - 2026-05-15

### Fixes

- Packaging: publish the CLI with a resolved core package dependency so registry installs work outside the workspace.

## 0.15.0 - 2026-05-15

### Features

- CLI providers: add GitHub Copilot CLI as `--cli copilot` / `--model cli/copilot`, including config, auto fallback, daemon model discovery, and Chrome extension settings (#211, thanks @izecell).
- CLI extraction: fall back to OpenAI vision OCR for image-only PDFs when markitdown returns only page headers, so `--extract` and forced preprocessing can recover scanned PDF text (#204, thanks @mvance).

### Fixes

- Test/release gates: ignore local Clawpatch metadata during format checks, align Node typings with the Node 24 engine floor, and cover media path/cache wiring.
- Test gates: wire `VITEST_MAX_THREADS` through Vitest 4 `maxWorkers` and add package bin/script regression coverage.
- Dependencies: update workspace packages and replace deprecated `@mariozechner/pi-ai` with `@earendil-works/pi-ai`.
- CLI performance: add opt-in startup/first-output tracing and avoid network LiteLLM catalog refreshes on fixed-model summary streaming and finish-line cost estimation.
- Chrome extension slides: harden slide payload loading against malformed cache/stream data and clear stale thumbnails before retrying updated slide images.
- Release gate: run `pnpm typecheck` during `pnpm check` so CI/release checks catch TypeScript errors.
- Typecheck: include `packages/core` in the root typecheck script so core library errors fail the gate.
- Tests: ignore invalid `VITEST_MAX_THREADS` overrides so Vitest never receives `maxThreads` below `minThreads`.
- CLI version: stop baking a stale git SHA into the committed `dist/cli.js` wrapper so checkout builds report the current commit.
- Chrome extension: keep local-video slide E2E shutdown from hanging, reject malformed media durations and non-video YouTube container URLs, and sanitize invalid advanced settings before they reach daemon requests.
- Parsing: reject non-decimal timestamp hrefs, malformed transcript clocks, malformed podcast durations, and non-decimal slide/retry numeric settings.
- Timestamps: reject malformed transcript, key-moment, slide, summary, and side-panel chat timestamps before they become prompt context or seek links.
- Slides: wait for background slide extraction to finish before URL flows exit, avoiding late cache writes during daemon shutdown.
- Daemon slides: ignore request-provided slide output directories and keep extracted slide artifacts under `~/.summarize/slides` (#220, thanks @Hinotoi-agent).
- Chrome extension automation: require confirmation before side-panel agent automation tools run, and report cancelled calls without applying navigation side effects (#219, thanks @Hinotoi-agent).
- Chrome extension automation: guard the artifacts bridge so browser JS can only read or write artifacts while extension-owned automation has armed the tab (#222, thanks @Hinotoi-agent).
- Chrome extension hover: ignore synthetic hover events and block hover summaries for localhost, private-network, link-local, and non-HTTP(S) URLs (#218, thanks @Hinotoi-agent).
- Refresh-free: keep `~/.summarize/config.json` rewrites and their config directory owner-only when updating free model candidates (#217, thanks @Hinotoi-agent).
- CLI progress: keep Ctrl+C responsive while spinners are active and forward interrupts to active CLI model backends so child processes are not left running (#216).
- Codex CLI: isolate normal summary runs with `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, a temporary cwd, and a sanitized temporary `CODEX_HOME` so local Codex context cannot bleed into summaries with little or no extracted content (#215, thanks @anntnzrb).
- Daemon: write `~/.summarize/daemon.json` with owner-only permissions and tighten existing config paths before rewriting daemon tokens or captured provider env values (#214, thanks @Hinotoi-agent).
- GitHub Models: ignore OpenAI-only request options such as `openai.thinking` / `--thinking` for `github-copilot/...` calls so Copilot summaries do not fail with GitHub Models `400` errors.
- Google document summaries: send `temperature` and `maxOutputTokens` inside Gemini `generationConfig` for document requests, and include API error details when Google rejects the payload (#209, thanks @vincent-peng).

## 0.14.1 - 2026-04-26

### Features

- Models: add OpenAI fast-service support via `--fast` / `--service-tier` and `--thinking`, keep `gpt-fast` / `fast` as compatibility aliases, and add explicit `codex-fast` for Codex CLI users.

## 0.14.0 - 2026-04-26

### Features

- Chrome extension: add a background extractor router with Reddit thread `.json` extraction and diagnostics while preserving media URL hard-switch behavior (#207, fixes #174, thanks @solomonneas).
- CLI extraction: support `--extract` for local PDF files through the existing markitdown preprocessing path, without requiring an LLM (#203, thanks @mvance).

### Fixes

- CLI auto models: include config-provided environment values when selecting `auto` candidates, so API keys in `~/.summarize/config.json` are honored for URL summaries (#206, fixes #205, thanks @kaihendry and @solomonneas).
- Chrome extension: skip always-on content scripts on Facebook, Instagram, and Meta CDN pages to avoid site compatibility issues (#208, fixes #106, thanks @solomonneas).

### Maintenance

- Dependencies: refresh direct and transitive packages to the latest compatible versions, including `es-toolkit` 1.46.0.

## 0.13.1 - 2026-04-22

### Fixes

- YouTube and cache: make `--no-cache` bypass cached URL extraction, forward `OPENAI_API_KEY` into media transcription, and surface yt-dlp transcription failures in diagnostics (#197, thanks @mvance).
- Chrome extension chat: isolate side-panel chat history by both tab and URL so navigating within a tab no longer shows another page's conversation (#189, thanks @Youpen-y).
- Chrome extension chat: honor `openai.useChatCompletions` for side-panel chat requests, including fixed and auto-selected OpenAI models (#155, thanks @Zevan770).
- Spotify podcasts: skip encrypted Spotify embed audio, fall back to publisher RSS enclosures, and surface podcast transcription failures instead of summarizing a bare URL.
- X extraction: surface unauthorized `xurl` responses with actionable auth/fallback guidance when Nitter is unavailable (#200, thanks @coygeek).
- OpenClaw CLI: call current OpenClaw with `-m/--message` and reject oversized prompts before hitting argv limits (#199, thanks @Silver-Aurora).
- Windows daemon: register the logon Scheduled Task via XML with battery-safe hidden launch settings, fix restart/uninstall process cleanup, and document the Administrator install flow (#192, thanks @ajmeese7).
- CLI providers: use stable default aliases for Gemini (`flash`) and Cursor Agent (`auto`) so installed CLI versions resolve supported models reliably (#193, thanks @mvance).
- CLI build: mark the generated `dist/cli.js` wrapper executable so `npm link` and global installs can run the binary directly on Unix-like systems (#191, thanks @maciej).
- CLI progress: show only the active transcription provider/model in status text instead of the full remote fallback chain.

## 0.13.0 - 2026-04-08

### Features

- Slides: support `--slides` for local video files in the main CLI and `summarize slides`, route local videos through the shared slide-aware flow, and document the local-file workflow (#149, thanks @steipete).
- Models: add explicit `github-copilot/...` model support backed by GitHub Models, including shorthand ids like `github-copilot/gpt-5.4` and `GITHUB_TOKEN` / `GH_TOKEN` auth.
- Models: add OpenCode as a first-class CLI provider across CLI flags, config, auto fallback, daemon picker/chat flows, and Chrome extension settings, while preserving existing OpenClaw behavior (#169, thanks @maciej).
- CLI providers: add OpenClaw as a configurable CLI backend (`--cli openclaw`, `cli/openclaw/...`, `openclaw/...`) across config, daemon discovery, and docs (#165, thanks @yqf-ai).
- Config: allow setting a default summary length via `output.length`, and keep prompt-override runs aligned with the configured length/language defaults in both CLI and daemon flows (#178, thanks @maciej).
- Media detection/cache: recognize `.m3u8` HLS playlists as direct media inputs and preserve the playlist extension in the media cache (#159, thanks @mdsakalu).

### Fixes

- OpenAI models: route GPT-5.4 / GPT-5.4 mini / GPT-5.4 nano / GPT-5 mini / GPT-5 nano text requests through direct provider APIs instead of the stale generic parser, preserve the real `gpt-5.4-mini` / `gpt-5.4-nano` ids end-to-end, and fall GitHub Models OpenAI GPT-5-family requests back to `gpt-5-chat` when GitHub rejects the raw id.
- GitHub Models: make `github-copilot/...` shorthand inference family-based instead of pinning old exact prefixes, so newer ids like `gpt-5.4`, `o5`, and `claude-opus-4.6` normalize correctly when the backend exposes them.
- Slides/local video: transcribe direct videos for slide summaries, avoid fake local-file “Downloading audio” phases, and keep progress text visible while slide extraction runs.
- Chrome extension slides: restore slide text/session state more reliably so reruns and reloads do not leave stale or blank slide summaries.
- Transcription: retry Groq Whisper uploads via `curl` when Node multipart uploads get a 403, fixing local `.ogg` regressions on some environments.
- YouTube: detect obviously truncated caption-track transcripts on long videos and fall through to yt-dlp transcription instead of caching a broken partial result (#184, thanks @sportiz91).
- YouTube: treat yt-dlp “no audio stream” videos as a non-fatal unavailable transcript case so summarize can continue cleanly with an explanatory note (#161, thanks @mdsakalu).
- Cache: include the prompt `<context>` block in summary cache hashing and bump the cache format version so stale cross-page summary collisions cannot be reused (#171, thanks @mvance).
- CLI providers: stream OpenClaw prompts over stdin instead of `--message`, make daemon side-panel chat honor `openai.useChatCompletions`/custom OpenAI-compatible base URLs, and stop leaking raw Codex JSONL events like `thread.started` when no assistant text was produced.
- Chrome extension: add a copy button for rendered summaries so results can be copied without manual selection.
- Chrome extension chat: handle plain-string assistant replies in the side-panel agent loop instead of crashing on `.filter()` tool-call extraction (#186, thanks @Youpen-y).
- Windows containers: let `summarize daemon install` start the daemon for the current container session without Scheduled Task registration, keep `0.0.0.0` binding Windows-only, and probe slide tools by spawning commands when PATH lookup is unreliable (#152, thanks @mathicg).
- Windows daemon: keep Scheduled Task startup hidden without breaking `summarize daemon restart` or uninstall by tracking the hidden daemon PID and killing that process tree before reruns/removal (#146, thanks @mathicg).
- Whisper.cpp: honor config-resolved transcription env overrides for readiness checks, model display, and local transcription so custom binary/model paths work outside `process.env` (#160, thanks @mdsakalu).
- Daemon models: gracefully fall back for unrecognized custom models when using proxy base URLs instead of crashing on undefined API metadata (#175, thanks @douo).
- Docs/setup: switch Homebrew instructions from the old tap to the official `brew install summarize` formula, including the side-panel setup UI and release checklist (#172, thanks @zeldrisho).
- Chrome extension: detect blank `userAgentData.platform` browsers like Vivaldi by falling back to `navigator.platform` before choosing OS-specific setup instructions (#158, thanks @bytrangle).
- Firecrawl: reject `--firecrawl always` for YouTube URLs with an explicit guidance error instead of silently skipping Firecrawl on the transcript-first path (#145, thanks @steipete).
- YouTube: keep Gemini-only no-caption runs on the transcription path by forwarding the Google API key from the top-level URL flow into link-preview transcription config (#148, thanks @bytrangle).
- Homebrew: make the tap formula fail clearly on Linux instead of installing a macOS binary, and add generator/test coverage for the macOS-only guard (#147, thanks @steipete).
- Maintenance: update the GitHub Pages workflow to `actions/configure-pages@v6` and `actions/deploy-pages@v5` (#182, thanks @dependabot).

## 0.12.0 - 2026-03-11

### Features

- Models: add `nvidia/...` provider alias (uses `NVIDIA_API_KEY` + optional `NVIDIA_BASE_URL`) for NVIDIA OpenAI-compatible endpoints.

### Fixes

- Transcription: add AssemblyAI as a first-class remote provider across direct media, podcast/RSS, and yt-dlp YouTube fallback; refactor remote fallback ordering, expand config/env support (`ASSEMBLYAI_API_KEY`, legacy `apiKeys.assemblyai`), and add AssemblyAI unit + live coverage (#126).
- X/Twitter: prefer `xurl` for tweet extraction when installed, fall back to `bird`, preserve long-form/article text plus media URLs, add live `xurl` extraction/media coverage, and replace the stale dead-`bird` install tip with a current X CLI recommendation (#70).
- Models: make daemon agent `artifacts` schemas Gemini-safe, improve Google empty-response handling with preview-to-stable fallback, and switch CLI/auto Gemini defaults away from brittle preview behavior (#82, #96).
- Agents: expand model auto-resolution errors with checked models, missing env/CLI setup, and daemon restart guidance (#107).
- Daemon: support multiple saved extension tokens, migrate legacy single-token configs, and accept any configured token for auth (#116).
- Chrome extension: harden side-panel slides so SSE keepalives no longer false-time out, seeded placeholders no longer block pending/cached slide runs, retries can start a fresh summarize+slides run, and reruns replace stale slide state.
- Chrome extension: refactor side-panel navigation/run attachment policy so late summary/slide runs no longer attach to the wrong page after tab or URL switches, and expand headless regression coverage for pending-run resume and slide-mode transitions.
- Chrome extension: default fresh installs to slide mode, keep passive tab navigation out of chat, and align slide cards with CLI `--slides` by preferring per-slide summary text over raw transcript/OCR fallback.
- Chrome extension tests: add stronger YouTube slide E2E coverage for loaded images, summary-backed slide text, and switching between videos mid-analysis without stale slide-summary bleed.
- Chrome extension: isolate slide-summary stream callbacks per run and harden Playwright settings hydration so late events no longer blank slide text when switching videos mid-analysis.
- Transcription: add Gemini audio/video transcription support across direct media, podcast/RSS, and yt-dlp YouTube fallback, including Files API uploads for larger media plus new Gemini live coverage (#89).
- npm packaging: publish CLI with `pnpm publish` so `@steipete/summarize-core` is version-pinned in published metadata (no `workspace:*` in registry package).
- Slides: detect WezTerm as an iTerm-compatible terminal for inline slide images in `--slides` mode. (#133) — thanks @doodaaatimmy-creator.
- CLI help: surface `summarize refresh-free` in `summarize help` output.
- CLI: report CLI provider timeouts explicitly, including the duration, command, and a `--timeout` hint instead of collapsing them into generic exec failures (#100, thanks @christophsturm).
- Daemon: restrict CORS responses to trusted extension and localhost origins, with regression coverage for allowed and denied `Origin` headers (#108, thanks @sebastiondev).
- Transcription: chunk oversized Groq Whisper uploads with ffmpeg in file mode instead of failing out on files above the 30MB limit (#134, thanks @WinnCook).
- Docs: tighten landing-page mobile layout so hero, cards, code blocks, and nav stay readable on narrow screens (#118, thanks @Acidias).
- Release: build macOS x64 Bun artifacts and add regression coverage for Homebrew formula rewrites during dual-arch releases (#122, thanks @androidshu).
- YouTube: tighten hostname validation across core, slides, and extension helpers so attacker-controlled lookalike hosts are no longer treated as YouTube URLs (#91, thanks @RinZ27).
- Config: honor `zai.baseUrl` config fallback for blank env values and keep Z.AI base URL overrides working outside the summary flow (#102, thanks @liuy).
- Chrome extension: tighten options and sidepanel UI spacing, copy actions, and advanced-controls layout for a cleaner panel experience (#86, thanks @morozRed).
- Slides: warn in summary mode when `--slides` dependencies are missing, and document required local installs for `ffmpeg`, `yt-dlp`, and optional `tesseract`.
- Docs: fix broken docs index links by setting an empty Jekyll `baseurl` (#113, thanks @Youpen-y).
- Models: preserve model id casing after the provider prefix so OpenAI-compatible proxies can route exact names correctly (#128, thanks @WinnCook).
- Cache: give extract entries with unavailable transcripts the same short retry TTL as negative transcript cache entries, so transient Apify failures can recover (#115, thanks @gluneau).
- Daemon: apply the saved env snapshot to `process.env` before `daemon run` starts so child tools inherit the right PATH and API/tool config under launchd/systemd (#99, thanks @heyalchang).
- Chrome automation: require sidepanel arming before debugger-backed native input can run in a tab, and auto-disarm after browser JS execution ends (#129, thanks @omnicoder9).
- Media setup: fix the local whisper.cpp install hint to use the current Homebrew formula name `whisper-cpp` (#92, thanks @zerone0x).
- CLI output: cap markdown render width on very wide terminals by default, with a `--width` override for manual control (#119, thanks @howardpen9).
- Slides: size inline slide images from terminal width instead of keeping them pinned to 32 columns, capped at 2x the previous width while preserving `COLUMNS` fallback behavior (#125, #135, thanks @WinnCook).
- Shell completions: add Fish shell completions for the current CLI flags and option values (#95, thanks @fbehrens).
- Bun fetch: only opt into compressed HTML/YouTube responses when running under Bun, and retry link-preview fetches with `Accept-Encoding: identity` after Bun decompression failures (#105, thanks @maciej).
- Daemon: support `cli/...` models in chat and agent endpoints, including CLI auto-fallback when no API-key transport is available (#109, thanks @jetm).

## 0.11.0 - 2026-02-14

### Highlights

- Auto CLI fallback: new controls and persisted last-success provider state (`~/.summarize/cli-state.json`) for no-key/local-CLI workflows.
- Transcription reliability: Groq Whisper is now the preferred cloud transcriber, with custom OpenAI-compatible Whisper endpoint overrides.
- Input reliability: binary-safe stdin handling, local media support in `--extract`, and fixes for local-file hangs/PDF preprocessing on custom OpenAI base URLs.

### Features

- CLI: add Cursor Agent provider (`--cli agent`) for CLI-model execution.
- CLI auto mode: add implicit auto CLI fallback controls (`cli.autoFallback`, `--auto-cli-fallback`) and provider priority controls (`cli.providers`, `--cli-priority`), with persisted provider success ordering.
- Transcription: add Groq Whisper as preferred cloud provider (#71, thanks @n0an).
- Transcription: support custom OpenAI-compatible Whisper endpoints via `OPENAI_WHISPER_BASE_URL` (with safe `OPENAI_BASE_URL` fallback) (#65, thanks @toanbot).
- Config: support generic `env` defaults in `~/.summarize/config.json` (fallback for any env var), while keeping legacy `apiKeys` mapping for compatibility (#63, thanks @entropyy0).

### Fixes

- CLI local files: avoid hangs when stream usage never resolves and preprocess PDFs automatically for custom OpenAI-compatible `OPENAI_BASE_URL` endpoints (e.g. non-`api.openai.com`).
- CLI stdin: support binary-safe piping/input temp files to prevent corruption on non-text stdin (#76).
- Extract mode: allow `--extract` for local media files (#72).
- Auto model/daemon fallback: skip model attempts when required API keys are missing and normalize env-key checks in daemon fallback (#67, #78).
- Cache: for auto presets (`auto`/`free`/named auto), prefer preset-level winner cache entries so stale per-candidate cache hits don’t override newer better-model results.
- Media: treat X broadcasts (`/i/broadcasts/...`) as transcript-first media and prefer URL mode.
- YouTube: keep explicit `--youtube apify` working when HTML fetch fails, while preserving duration metadata parity (#64, thanks @entropyy0).
- Transcription: stabilize Groq-first fallback flow (no duplicate Groq retries in file mode), improve terminal error reporting, and surface Groq setup in media guidance (#71, thanks @n0an).
- Media detection: detect more direct media URL extensions including `.ogg`/`.opus` (#65, thanks @toanbot).
- Slides: allow yt-dlp cookies-from-browser via `SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER` to avoid YouTube 403s.
- Daemon install: resolve symlinked/global bin paths and Windows shims when locating the CLI for install (#57, #62, thanks @entropyy0).
- Extraction: strip hidden HTML + invisible Unicode before summarization or extract output (#61).
- CLI: honor `--lang` for YouTube transcript→Markdown conversion in `--markdown-mode llm` (#56, thanks @entropyy0).
- LLM: map Anthropic bare model ids to versioned aliases (`claude-sonnet-4` → `claude-sonnet-4-0`) (#55, thanks @entropyy0).

### Improvements

- Tooling: remove Biome and standardize on `oxfmt` + type-aware `oxlint`; `pnpm check` now enforces `format:check` before lint/tests.
- Dependencies: update workspace dependencies to latest (including `@mariozechner/pi-ai` and `oxlint-tsgolint`).

## 0.10.0 - 2026-01-22

### Highlights

- Chrome Side Panel: **Chat mode** with metrics bar, message queue, and improved context (full transcript + summary metadata, jump-to-latest).
- Media-aware summarization in the Side Panel: Page vs Video/Audio dropdown, automatic media preference on video sites, plus visible word count/duration.
- Slides: **YouTube slide screenshots + OCR + transcript-aligned cards**, timestamped seek, and an OCR/Transcript toggle.
- CLI: robust URL + media extraction with transcript-first workflows and cache-aware streaming.

### Features

- Chrome Side Panel chat: stream agent replies over SSE and restore chat history from daemon cache (#33, thanks @dougvk).
- Media-aware summarization in the Side Panel: Page vs Video/Audio dropdown, automatic media preference on video sites, plus visible word count/duration.
- Transcripts: `--timestamps` adds segment-level timings (`transcriptSegments` + `transcriptTimedText`) for YouTube, podcasts, and embedded captions.
- Summaries: when transcript timestamps are available, prompts require timestamped bullet summaries; side panel auto-links `[mm:ss]` in summaries for media.
- Chrome Side Panel chat: timestamped transcript context plus clickable `[mm:ss]` links that seek the current media.
- Slides: extract slide screenshots + OCR for YouTube/direct video URLs in the CLI + extension (#41, thanks @philippb).
- Slides: top-of-summary slide strip with expand/collapse full-width cards, timestamps, and click-to-seek.
- Slides: slide descriptions without model calls (transcript windowing, OCR fallback) + OCR/Transcript toggle.
- Slides: stream slide extraction status/progress and show a single header progress bar (no duplicate spinners).
- CLI: transcribe local audio/video files with mtime-aware transcript cache invalidation (thanks @mvance!).
- Browser extension: add Firefox sidebar build + multi-browser config (#31, thanks @vlnd0).
- CLI: add Cursor Agent CLI provider (`cli/agent`, `--cli agent`).
- Chrome automation: add artifacts tool + REPL helpers for persistent session files (notes/JSON/CSV) and downloads.
- Chrome automation: expand navigate tool with list/switch tab support and return matching skills after navigation.

### Fixes

- Extract-only: remove implicit 8k cap; new `--max-extract-characters`/daemon `maxExtractCharacters` allow opt-in limits; resolves transcript truncation.
- Media: route direct media URLs to the transcription pipeline and raise the local media limit to 2GB (#47, thanks @n0an).
- Daemon (macOS): `daemon install` now falls back from `launchctl bootstrap gui/<uid>` to `user/<uid>` and resolves sudo/root uid targeting to avoid bootstrap `Input/output error` / `Domain does not support specified action` failures (#75).
- Slides: allow yt-dlp cookies-from-browser via `SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER` to avoid YouTube 403s.
- Chrome Side Panel chat: support JSON agent replies with explicit SSE/JSON negotiation to avoid “stream ended” errors.
- Chrome Side Panel: scope streams/state per window so other windows don’t wipe active summaries.
- Chrome Side Panel chat: keep auto-scroll pinned while streaming when you’re already at the bottom.
- Chrome Side Panel chat: clear streaming placeholders on errors/aborts.
- Chrome Side Panel: add inline error toast above chat composer; errors stay visible when scrolled.
- Chrome Side Panel: clear/hide the inline error toast when no message is present to avoid empty red boxes.
- Cache: include transcript timestamp requests in extract cache keys so timed summaries don’t reuse plain transcript content.
- CLI: `--no-cache` now bypasses summary caching only; transcript/media caches still apply.
- Media: treat X broadcasts (`/i/broadcasts/...`) as transcript-first media and prefer URL mode.
- Daemon: avoid URL flow crashes when url-preference helpers are missing (ReferenceError guard).
- YouTube: prefer English caption variants (`en-*`) when selecting caption tracks.
- Prompts: ignore sponsor/ads segments in video and podcast summaries.
- Prompts: enforce no-ads/no-skipped language and italicized standout excerpts (no quotation marks).
- Slides: render Slide X/Y labels and parse slide markers more robustly in streaming output.
- Slides: parse `Slide N/Total` labels and stabilize title/body extraction.
- Slides: ensure slide summary segments start with a title line when missing.
- Slides: detect headline-style first lines and render them as slide titles (no required `Title:` markers).
- Slides: progress updates during yt-dlp downloads and OSC progress mirrors slide extraction.
- Slides: reuse the media cache for downloaded videos (even with `--no-cache`).
- Slides: clear slide progress line before the finish summary to avoid stray `Slides x/y` output.
- CLI status line: ignore empty/ANSI-only spinner updates and duplicate texts to prevent flicker/blank status frames.
- Automation: require userScripts (no isolated-world fallback), with improved guidance and in-panel permission notice.
- CLI: clear OSC progress on SIGINT/SIGTERM to avoid stuck indicators.
- CLI local files: avoid hangs when stream usage never resolves and preprocess PDFs automatically for custom OpenAI-compatible `OPENAI_BASE_URL` endpoints (e.g. non-`api.openai.com`).

### Improvements

- Tooling: remove Biome and standardize on `oxfmt` + type-aware `oxlint`; `pnpm check` now enforces `format:check` before lint/tests.
- Transcription: add auto transcriber selection (default) with ONNX-first when configured + `summarize transcriber setup`.
- Cache: add media download caching with TTL/size caps + optional verification, plus `--no-media-cache`.
- CLI: add themed output (24-bit ANSI), `--theme`, and config/env defaults for a consistent color scheme.
- CLI: show determinate transcription progress percent when duration is known.
- CLI: show determinate OSC progress for transcription/download when totals are known.
- CLI: keep OSC progress determinate when recent percent updates are available.
- CLI: theme transcription progress lines and mirror part-based progress to OSC when duration is unknown.
- CLI: theme tweet/extraction progress lines for consistent loading indicators.
- CLI: theme file/slide spinner labels so all progress lines share the same styling.
- CLI: simplify media download labels (avoid “media, video” duplication).
- Slides: cap auto slide targets at 6 by default for long videos.
- Slides: render headline-style first lines as slide titles above the slide marker.
- Media: refactor routing helpers and size policy (#48, thanks @steipete).
- Daemon: emit slides start/progress/done metadata in extended logging for easier debugging.
- Prompts: allow straight quotes and encourage 1-2 short exact quotes when relevant.

### Docs

- README: 0.10.0 preview layout with clearer install flow, daemon rationale, and prominent Chrome Web Store link.
- README/docs: add UI theme config + ONNX install hints.
- README: document ONNX transcriber setup + auto selection.

## 0.9.0 - 2025-12-31

### Highlights

- Chrome Side Panel: **Chat mode** with metrics bar, message queue, and improved context (full transcript + summary metadata, jump-to-latest, smoother auto-scroll).
- Media-aware summarization in the Side Panel: Page vs Video/Audio dropdown, automatic media preference on video sites, plus visible word count/duration.
- Chrome extension: optional hover tooltip summaries for links (advanced setting, default off; experimental) with prompt customization.

### Improvements

- PDF + asset handling: send PDFs directly to Anthropic/OpenAI/Gemini when supported; generic PDF attachments and better media URL detection.
- Daemon: `/v1/chat` + `extractOnly`, version in health/status pill, optional JSON log with rotation, and more resilient restart/install health checks.
- Side Panel: advanced model row with “Scan free” (shows top free model after scan), a refresh summary control (cache bypass), plus richer length tooltips.
- Side Panel UX: consolidated advanced layout and typography controls (font size A/AA, line-height), streamlined setup panel with inline copy, clearer status text, and tighter model/length controls.
- Side Panel UX: keep the Auto summarize toggle on one line in Advanced.
- Streaming/metrics polish: faster stream flushes, shorter OpenRouter labels on wrap, and improved extraction metadata in chat.

### Fixes

- Auto model selection: OpenRouter fallback now resolves provider-specific ids (dash/dot slug normalization) and skips fallback when no unique match.
- Language auto: default to English when detection is uncertain.
- OpenAI GPT-5: skip `temperature` in streaming requests to avoid 400s for unsupported params.
- Side Panel stability: retryable stream errors, no abort crash, auto-summarize on open/source switch, synced chat toggle state, and caret alignment.
- YouTube duration handling: player API/HTML/yt-dlp fallbacks, transcript metadata propagation, and extension duration fallbacks.
- URL extraction: preserve final redirected URLs so shorteners (t.co) summarize the real destination.
- Hover summaries: proxy localhost daemon calls to avoid Chrome “Local network access” prompts.
- Install: use npm releases for osc-progress/tokentally instead of git deps.

## 0.8.2 - 2025-12-28

### Breaking

- ESM-only: `@steipete/summarize` + `@steipete/summarize-core` no longer support CommonJS `require()`; the CLI binary is now ESM.

### Highlights

- Chrome: add a real **Side Panel** extension (MV3) that summarizes the **current tab** and renders streamed Markdown.
- Daemon: add `summarize daemon …` (localhost server on `127.0.0.1:8787`) for extension ↔ CLI integration.
  - Autostart: macOS LaunchAgent, Linux systemd user service, Windows Scheduled Task
  - Token pairing (shared secret)
  - Streaming over SSE
  - Emit finish-line metrics over SSE (panel footer + hover details)
  - Commands: `install`, `status`, `restart`, `uninstall`, `run`
- Cache: add SQLite cache for transcripts/extractions/summaries with `--no-cache`, `--cache-stats`, `--clear-cache` + config (`cache.enabled/maxMb/ttlDays/path`).
  - Finish line shows “Cached” for summary cache hits (CLI + daemon/extension)
  - Daemon/Chrome stream cache status metadata (`summaryFromCache`)

### Features

- YouTube: add `--youtube no-auto` to skip auto-generated captions and prefer creator-uploaded captions; fall back to `yt-dlp` transcription (thanks @dougvk!).
- CLI: add transcript → Markdown formatting via `--extract --format md --markdown-mode llm` (thanks @dougvk!).
- X/Twitter: auto-transcribe tweet videos via `yt-dlp`, using browser cookies (Chrome → Safari → Firefox) when available; set `TWITTER_COOKIE_SOURCE` / `TWITTER_*_PROFILE` to control cookie extraction order.
- Prompt overrides: add `--prompt`, `--prompt-file`, and config `prompt` to replace the default summary instructions.
- Chrome Side Panel: add length + language controls (presets + custom), forwarded to the daemon.
- Daemon API: `mode: "auto"` accepts both `url` + extracted page `text`; daemon picks the best pipeline (YouTube/podcasts/media → URL, otherwise prefer visible page text) with a fallback attempt.
- Daemon/Chrome: stream extra run metadata (`inputSummary`, `modelLabel`) over SSE for richer panel status.
- Core: expose lightweight URL helpers at `@steipete/summarize-core/content/url` (YouTube/Twitter/podcast/direct-media detection).
- Chrome Side Panel: new icon + extension `homepage_url` set to `summarize.sh`.
- Providers: add configurable API base URLs (config + env) for OpenAI/Anthropic/Google/xAI (thanks @bunchjesse for the nudge).

### Fixes

- Packaging: ensure runtime deps and core tarball are included in published CLI bundles.

### Improvements

- Chrome Side Panel: stream SSE from the panel (no MV3 background stalls), use runtime messaging to avoid “disconnected port” errors, and improve auto-summarize de-dupe.
- Chrome Side Panel UI: working status in header + 1px progress line (no layout jump), full-width subtitle, page title in header, idle subtitle shows `words/chars` (or media duration + words) + model, subtle metrics footer, continuous background, and native highlight/link accents.
- Daemon: prefer the installed env snapshot over launchd’s minimal environment (improves `yt-dlp` / `whisper.cpp` PATH reliability, especially for X/Twitter video transcription).
- X/Twitter: cookie handling now delegates to `yt-dlp --cookies-from-browser` (no sweet-cookie dependency).
- X/Twitter: skip yt-dlp transcript attempts for long-form tweet text (articles).
- Transcripts: show yt-dlp download progress bytes and stabilize totals to prevent bouncing progress bars.
- Finish line: show transcript source labels (`YouTube` / `podcast`) without repeating the label.
- Streaming: stop/clear progress UI before first streamed output and avoid leading blank lines on non-TTY stdout.
- URL flow: propagate `extracted.truncated` into the prompt context so summaries can reflect partial inputs.
- Daemon: unify URL/page summarization with the CLI flows (single code path; keeps extract/cache/model logic in sync).
- Prompts: auto-require Markdown section headings for longer summaries (xl/xxl or large custom lengths).

## 0.7.1 - 2025-12-26

### Fixed

- Packaging: `@steipete/summarize-core` now ships a CJS build for `require()` consumers (fixes `pnpm dlx @steipete/summarize --help` and the published CLI runtime).

## 0.7.0 - 2025-12-26

### Highlights

- Packages: split into `@steipete/summarize-core` (library) + `@steipete/summarize` (CLI; depends on core). Versions are lockstep.
- Streaming: scrollback-safe Markdown streaming (hybrid: line-by-line + block buffering for fenced code + tables). No cursor control, no full-frame redraws.
- Output: Markdown rendering is automatic on TTY; use `--plain` for raw Markdown/text output.
- Finish line: compact separators (`·`) and no duplicated `… words` when transcript stats are shown.
- YouTube: `--youtube auto` prefers `yt-dlp` transcription when available; Apify is last-last resort.

### Fixed

- Streaming: flush newline-bounded output in `--plain` mode to avoid duplication with cumulative stream chunks.
- Website extraction: strip inline CSS before Readability to avoid extremely slow jsdom stylesheet parsing on some pages.
- Twitter/X: rotate Nitter hosts and skip Anubis PoW pages during tweet fallback.

### Changed

- CLI: remove `--render`; add `--plain` to keep raw output (no ANSI/OSC rendering).

## 0.6.1 - 2025-12-25

### Changes

- YouTube: `--youtube auto` now falls back to `yt-dlp` if it’s on `PATH` (or `YT_DLP_PATH` is set) and a Whisper provider is available.
- `--version` now includes a short git SHA when available (build provenance).
- `--extract` now defaults to Markdown output (when `--format` is omitted), preferring Readability input.
- `--extract` no longer spends LLM tokens for Markdown conversion by default (unless `--markdown-mode llm` is used).
- `--format md` no longer forces Firecrawl; use `--firecrawl always` to force it.
- Finish line in `--extract` shows the extraction path (e.g. `markdown via readability`) and omits noisy `via html` output.
- Finish line always includes the model id when an LLM is used (including `--extract --markdown-mode llm`).
- `--extract` renders Markdown in TTY output (same renderer as summaries) when `--render auto|md` (use `--render plain` for raw Markdown).
- Suppress transcript progress/failure messages for non-YouTube / non-podcast URLs.
- Streaming now works with auto-selected models (including `--model free`) when `--stream on|auto`.
- Warn when `--length` is explicitly provided with `--extract` (ignored; no summary is generated).

## 0.6.0 - 2025-12-25

### Features

- **Podcasts (full episodes)**
  - Support Apple Podcasts episode URLs via iTunes Lookup + enclosure transcription (avoids slow/blocked HTML).
  - Support Spotify episode URLs via the embed page (`/embed/episode/...`) to avoid recaptcha; fall back to iTunes RSS when embed audio is DRM/missing.
  - Prefer local `whisper.cpp` when installed + model available (no API keys required for transcription).
  - Whisper transcription works for any media URL (audio/video containers), not just YouTube.
- **Language**
  - Add `--language/--lang` (default: `auto`, match source language).
  - Add config support via `output.language` (legacy `language` still supported).
- **Progress UI**
  - Add two-phase progress for podcasts: media download + Whisper transcription progress.
  - Show transcript phases (YouTube caption/Apify/yt-dlp), provider + model, and media size/duration.

### Changes

- **Transcription**
  - Add lenient ffmpeg transcode fallback for local Whisper when strict decode fails (e.g. Spotify AAC).

- **Models**
  - Add `zai/...` model alias with Z.AI base URL + chat completions by default.
  - Add `OPENAI_USE_CHAT_COMPLETIONS` + `openai.useChatCompletions` config toggle.
- **Metrics / output**
  - `--metrics on|detailed`: finish line includes compact transcript stats (… words, …) + media duration (when available); `--metrics detailed`: also prints input/transcript sizes + transcript source/provider/cache; hides `calls=1`.
  - Smarter duration formatting (`1h 13m 4s`, `44s`) and rounded transfer rates.
  - Make Markdown links terminal-clickable by materializing URLs.
  - `--metrics on|detailed` renders a single finish line with a compact transcript block (… words, …) before the model.
- **Cost**
  - Include OpenAI Whisper transcription estimate (duration-based) in the finish line total (`txcost=…`); configurable via `openai.whisperUsdPerMinute`.

### Docs

- Add `docs/language.md` and document language config + flag usage.

### Tests

- Add JSON-LD graph extraction coverage.
- Extend live podcast-host coverage (Podchaser, Spreaker, Buzzsprout).
- Raise global branch coverage threshold to 75% and add regression coverage for podcast/language/progress paths.

## 0.5.0 - 2025-12-24

### Features

- **Model selection & presets**
  - Automatic model selection (`--model auto`, now the default):
    - Chooses models based on input kind (website/YouTube/file/image/video/text) and prompt size.
    - Skips candidates without API keys; retries next model on request errors.
    - Adds OpenRouter fallback attempts when `OPENROUTER_API_KEY` is present.
    - Shows the chosen model in the progress UI.
  - Named model presets via config (`~/.summarize/config.json` → `models`), selectable as `--model <preset>`.
  - Built-in preset: `--model free` (OpenRouter `:free` candidates; override via `models.free`).
- **OpenRouter free preset maintenance**
  - `summarize refresh-free` regenerates `models.free` by scanning OpenRouter `:free` models and testing availability + latency.
  - `summarize refresh-free --set-default` also sets `"model": "free"` in `~/.summarize/config.json` (so free becomes your default).
- **CLI models**
  - Add `--cli <provider>` flag (equivalent to `--model cli/<provider>`).
  - `--cli` accepts case-insensitive providers and can be used without a provider to enable CLI auto selection.
- **Content extraction**
  - Website extraction detects video-only pages:
    - YouTube embeds switch to transcript extraction automatically.
    - Direct video URLs can be downloaded + summarized when `--video-mode auto|understand` and a Gemini key is available.
- **Env**
  - `.env` in the current directory is loaded automatically (so API keys work without exporting env vars).

### Changes

- **CLI config**
  - Auto mode uses CLI models only when `cli.enabled` is set; order follows the list.
  - `cli.enabled` is an allowlist for CLI usage.
- **OpenRouter**
  - Stop sending extra routing headers.
  - `--model free`: when OpenRouter rejects routing with “No allowed providers”, print the exact provider names to allow and suggest running `summarize refresh-free`.
  - `--max-output-tokens`: when explicitly set, it is also forwarded to OpenRouter calls.
- **Refresh Free**
  - Default extra runs reduced to 2 (total runs = 1 + runs) to reduce rate-limit pressure.
  - Filter `:free` candidates by recency (default: last 180 days; configurable via `--max-age-days`).
  - Print `ctx`/`out` in `k` units for readability.
- **Defaults**
  - Default summary length is now `xl`.

### Fixes

- **LLM / OpenRouter**
  - LLM request retries (`--retries`) and clearer timeout errors.
  - `summarize refresh-free`: detect OpenRouter free-model rate limits and back off + retry.
- **Streaming**
  - Normalize + de-dupe overlapping chunks to prevent repeated sections in live Markdown output.
- **YouTube**
  - Prefer manual captions over auto-generated when both exist. Thanks @dougvk.
  - Always summarize YouTube transcripts in auto mode (instead of printing the transcript).
- **Prompting & metrics**
  - Don’t “pad” beyond input length when asking for longer summaries.
  - `--metrics detailed`: fold metrics into finish line and make labels less cryptic.

### Docs

- Add documentation for presets and Refresh Free.
- Add a “make free the default” quick start for `summarize refresh-free --set-default`.
- Add a manual end-to-end checklist (`docs/manual-tests.md`).
- Add a quick CLI smoke checklist (`docs/smoketest.md`).
- Document CLI ordering and model selection behavior.

### Tests

- Add coverage for presets and Refresh Free regeneration.
- Add live coverage for the `free` preset.
- Add regression coverage for YouTube transcript handling and metrics formatting.

## 0.4.0 - 2025-12-21

### Changes

- Add URL extraction mode via `--extract` with `--format md|text`.
- Rename HTML→Markdown conversion flag to `--markdown-mode`.
- Add `--preprocess off|auto|always` and a `uvx markitdown` fallback for Markdown extraction and unsupported file attachments (when `--format md` is used).

## 0.3.0 - 2025-12-20

### Changes

- Add yt-dlp audio transcription fallback for YouTube; prefer OpenAI Whisper with FAL fallback. Thanks @dougvk.
- Add `--no-playlist` to yt-dlp downloads to avoid transcript mismatches.
- Run yt-dlp after web + Apify in `--youtube auto`, and error early for missing keys in `--youtube yt-dlp`.
- Require Node 22+.
- Respect `OPENAI_BASE_URL` when set, even with OpenRouter keys.
- Add OpenRouter configuration tests. Thanks @dougvk for the initial OpenRouter support.
- Build and ship a Bun bytecode arm64 binary for Homebrew.

### Tests

- Add coverage for yt-dlp ordering, missing-key errors, and helper paths.
- Add live coverage for yt-dlp transcript mode and missing-caption YouTube pages.

### Dev

- Add `Dockerfile.test` for containerized yt-dlp testing.

## 0.2.0 - 2025-12-20

### Changes

- Add native OpenRouter support via `OPENROUTER_API_KEY`.
- Remove map-reduce summarization; reject inputs that exceed the model's context window.
- Preflight text prompts with the GPT tokenizer and the model’s max input tokens.
- Reject text files over 10 MB before tokenization.
- Reject too-small numeric `--length` and `--max-output-tokens` values.
- Cap summaries to the extracted content length when a requested size is larger.
- Skip summarization for tweets when extracted content is already below the requested length.
- Use bird CLI for tweet extraction when available and surface it in the status line.
- Fall back to Nitter for tweet extraction when bird fails; report a clear error when tweet data is unavailable.
- Compute cost totals via tokentally’s tally helpers.
- Improve fetch spinner with elapsed time and throughput updates.
- Show Firecrawl fallback status and reason when scraping kicks in.
- Enforce a hard deadline for stalled streaming LLM responses.
- Merge cumulative streaming chunks correctly and keep stream-merge for streaming output.
- Fall back to non-streaming when streaming requests time out.
- Preserve parentheses in URL paths when resolving inputs.
- Stop forcing Firecrawl for --extract-only; only use it as a fallback.
- Avoid Firecrawl fallback when block keywords only appear in scripts/styles.

### Tests

- Add CLI + live coverage for prompt length capping.
- Add coverage for cumulative stream merge handling.
- Add coverage for streaming timeout fallback.
- Add live coverage for Wikipedia URLs with parentheses.
- Add coverage for tweet summaries that bypass the LLM when short.
- Add coverage for content budget paths and TOKENTALLY cache dir overrides.

### Docs

- Update release checklist to all-in-one flow.
- Fix release script quoting.
- Document input limits and minimum length/token values.

### Dev

- Add a tokenization benchmark script.

### Fixes

- Preserve balanced parentheses/brackets in URL paths (e.g. Wikipedia titles).
- Avoid Firecrawl fallback when block keywords only appear in scripts/styles.
- Add a Bird install tip when Twitter/X fetch fails without bird installed.
- Graceful error when tweet extraction fails after bird + Nitter fallback.

## 0.1.2 - 2025-12-20

### Fixes

- Release tooling: repair script quoting (no user-visible changes).

## 0.1.1 - 2025-12-19

### Fixes

- Accept common “pasted URL” patterns like `url (canonical)` and clean up accidental `\\?` / `\\=` / `%5C` before query separators.

## 0.1.0 - 2025-12-19

First public release.

### CLI

- `summarize` CLI shipped via `@steipete/summarize` (plus optional library exports).
- Inputs: URL, local file path, or remote file URL (PDFs/images/audio/video/text).
- Automatic map-reduce for large inputs.
- Streaming output by default on TTY, with Markdown → ANSI rendering (via `markdansi`).
- Final “Finished in …” line: timing, token usage, cost estimate (when pricing is available), and service counts.
- Flags:
  - `--model <provider/model>` (default `google/gemini-3-flash-preview`)
  - `--length short|medium|long|xl|xxl|<chars>` (guideline; no hard truncation)
  - `--max-output-tokens <count>` (optional hard cap)
  - `--timeout <duration>` (default `2m`)
  - `--stream auto|on|off`, `--render auto|md|plain`
  - `--extract` (URLs only; no summary)
  - `--json` (structured output incl. input config, prompt, extracted content, LLM metadata, and metrics)
  - `--metrics off|on|detailed` (default `on`)
  - `--verbose`

### Sources

- Websites: fetch + extract “article-ish” content + normalization for prompts.
- Firecrawl fallback for blocked/thin sites (`--firecrawl off|auto|always`, via `FIRECRAWL_API_KEY`).
- Markdown extraction for websites in `--extract` mode (`--format md|text`, `--markdown-mode off|auto|llm`).
- YouTube (`--youtube auto|web|apify`):
  - best-effort transcript endpoints
  - optional Apify fallback (requires `APIFY_API_TOKEN`; single actor `faVsWy9VTSNVIhWpR`)
- Files (remote or local): MIME sniffing + best-effort forwarding to the model.
  - text-like inputs are inlined for provider compatibility

### LLM providers

- Direct-provider API keys (no gateway).
- OpenAI-compatible base URL support (`OPENAI_BASE_URL`, `OPENROUTER_API_KEY`).
- Model ids: `openai/...`, `anthropic/...`, `xai/...`, `google/...`.
- Auto-handling of provider/model limitations (e.g. no streaming support → non-streaming call; unsupported media types → friendly error).

### Pricing + limits

- Token/cost estimates and model limits derived from LiteLLM’s model catalog, downloaded + cached under `~/.summarize/cache/`.

### Quality

- CI: lint, tests (coverage), and pack.
- Tooling: Biome (lint/format) + Vitest (tests + coverage gate).

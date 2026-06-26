---
title: "Extract"
kicker: "modes"
summary: "Extract mode behavior and markdown handling."
read_when:
  - "When changing extract pipeline or flags."
---

# Extract mode

`--extract` prints the extracted content and exits.

Deprecated alias: `--extract-only`.

## Notes

- No summarization LLM call happens in this mode.
- Supported inputs are URLs, YouTube/direct media, local audio/video, and local PDF files (`-` stdin is not supported with `--extract`).
- Extraction can still use configured remote transcription, OCR, or Markdown providers for media/PDF inputs. For sensitive files, use local transcription/provider settings for media and `--preprocess off` when you need to block PDF/Markdown preprocessing.
- No extraction cap is applied. Use `--max-extract-characters <count>` to cap output if needed.
- `--format md` may still convert HTML to Markdown (depending on `--markdown-mode` and available tools).
- `--length` is intended for summarization guidance; extraction prints full content.
- `--timestamps` keeps the plain transcript text but also exposes `transcriptSegments` and `transcriptTimedText` (JSON) and prints a timed transcript block when available.
- YouTube transcript output includes the public view count when available. JSON exposes `extracted.sourceMetrics` with `platform`, `videoId`, `viewCount`, and `observedAt`; human output prints `YouTube views: <count>` before the transcript. Metrics refresh at least hourly even when the transcript remains cached.
- `--slides` runs slide detection (YouTube/direct video URLs/local video files). Slide metadata is included in JSON output and written to `slides.json` in the slide directory.
  - When combined with `--extract` for videos that have timed transcripts, the CLI interleaves slide images inline at matching timestamps.
  - Scene detection auto-tunes using sampled frame hashes.
- For non-YouTube URLs with `--format md`, the CLI uses Readability article HTML as the default Markdown input (`--markdown-mode readability`).
  - Use `--markdown-mode auto` to prefer LLM/markitdown conversion without Readability preprocessing.
  - Use `--markdown-mode llm` to force an LLM conversion.
  - Use `--firecrawl always` to try Firecrawl first for non-YouTube URLs.
- For non-YouTube URLs with `--format md`, `--markdown-mode auto` can convert HTML to Markdown via an LLM when configured.
  - Force it with `--markdown-mode llm`.
  - If no LLM is configured, `--markdown-mode auto` may fall back to `uvx markitdown` when available.
- `--markdown-mode readability` uses Readability to extract article HTML before Markdown conversion.

Daemon note:

- `/v1/summarize` supports `format: "markdown"` + `markdownMode` for extract-only output (use `extractOnly: true`).

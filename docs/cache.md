---
title: "Cache"
kicker: "internals"
summary: "CLI cache design, keys, config, and eviction."
read_when:
  - "When changing cache behavior, keys, or defaults."
---

# Cache (design)

Lightweight, CLI-only SQLite cache. Single DB file.

## Goals

- Avoid repeated transcripts/extractions/summaries.
- No file sprawl; bounded disk usage.
- Safe defaults; easy opt-out.
- Native SQLite only (Node 24 + Bun).

## Storage

- Default path: `~/.summarize/cache.sqlite`
- Override: `cache.path` in config.
- SQLite pragmas: WAL, NORMAL sync, busy timeout, incremental vacuum.

## Media cache (downloads)

Separate file cache for downloaded media (yt-dlp, direct media URLs). This is **not** the SQLite DB.

- Default path: `~/.summarize/cache/media`
- TTL: 7 days
- Size cap: 2048 MB
- Config: `cache.media` (see below)
- CLI: `--no-media-cache` disables media caching only
- Note: `--no-cache` **does not** disable the media cache

## What we cache

- **Transcripts**
  - key: `sha256({url, namespace, fileMtime?, formatVersion})` (local file paths include `fileMtime` for invalidation)
- **Extracted content** (URL → text/markdown)
  - key: `sha256({url, extractSettings, formatVersion})`
- **Summaries**
  - key: `sha256({contentHash, promptHash, model, length, language, formatVersion})`
  - cache hit even if URL differs (content hash wins).
  - `contentHash` comes from the `<content>` block actually sent to the model (so slide timelines / transcript extras affect the key).
- **Slides** (manifest + on-disk images in the slides output dir)
  - key: `sha256({url, slideSettings, formatVersion})`

## Keys / hashes

- `sha256` from Node `crypto` / Bun `crypto`.
- `contentHash` from normalized prompt `<content>` (fallback: normalized extracted content when no tagged block exists).
- `promptHash` from instruction block (custom prompt or default).
- `formatVersion`: hardcoded constant to invalidate on prompt format changes.

## Config

```json
{
  "cache": {
    "enabled": true,
    "maxMb": 512,
    "ttlDays": 30,
    "path": "~/.summarize/cache.sqlite",
    "media": {
      "enabled": true,
      "maxMb": 2048,
      "ttlDays": 7,
      "path": "~/.summarize/cache/media",
      "verify": "size"
    }
  }
}
```

Defaults: `enabled=true`, `maxMb=512`, `ttlDays=30`, `path` unset.

## CLI flags

- `--no-cache`: bypass summary cache reads + writes (LLM output). Extract/transcript caches still apply.
- `--cache-stats`: print cache stats and exit.
- `--clear-cache`: delete cache DB (and WAL/SHM); must be used alone.

## Eviction policy

- TTL sweep on read/write.
- Size cap: if DB > `maxMb`, delete oldest entries by `last_accessed_at` until under cap.
- Optional count cap if needed later.

Media cache eviction:

- TTL sweep on read/write.
- Size cap: evict least-recently-used files until under cap.
- `verify` controls integrity checks: `size` (default), `hash`, or `none`.

## Notes

- No extension cache (daemon uses CLI cache).
- No third-party SQLite deps.
- Transcript namespace currently includes the YouTube mode (e.g. `yt:auto`, `yt:web`).

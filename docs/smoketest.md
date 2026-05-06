---
title: "Smoke test"
kicker: "project"
summary: "20-case smoke test plan for inputs and models."
read_when:
  - "When running smoke tests."
---

# Smoke Test Plan (20 combos)

Goal: exercise URL + file inputs, extraction + LLM summary paths, multiple models.

## Preconditions

- API keys set for at least: `OPENAI_API_KEY`, `GEMINI_API_KEY`.
- Optional: `FIRECRAWL_API_KEY` to test fallback (if available).

## Models (cheap/fast)

- `openai/gpt-5-mini`
- `google/gemini-3-flash`

## Matrix (20 cases)

### Websites (LLM summary, 10)

1. Static HTML: `https://example.com` (model: gemini-3-flash)
2. Wikipedia article: `https://en.wikipedia.org/wiki/Swift_(programming_language)` (model: gpt-5-mini)
3. MDN doc: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/200` (model: gemini-3-flash)
4. Reuters article: `https://www.reuters.com/world/` (model: gpt-5-mini)
5. BBC article: `https://www.bbc.com/news` (model: gemini-3-flash)
6. GitHub README: `https://github.com/vitejs/vite` (model: gpt-5-mini)
7. Substack post: pick any public post (model: gemini-3-flash)
8. Medium post: pick any public post (model: gpt-5-mini)
9. JS-heavy page: `https://vercel.com` (model: gemini-3-flash)
10. 404 page: `https://example.com/does-not-exist` (model: gpt-5-mini)

### YouTube (LLM summary, 2)

11. Captions available: pick a popular talk/interview (model: gemini-3-flash, `--youtube auto`)
12. No captions: pick a random channel upload w/o captions (model: gpt-5-mini, `--youtube auto`)

### Remote files (LLM summary, 4)

13. PDF URL: any public PDF report (model: gemini-3-flash)
14. PNG URL: `https://upload.wikimedia.org/wikipedia/commons/7/70/Example.png` (model: gpt-5-mini)
15. MP3 URL: any public MP3 sample (model: gemini-3-flash)
16. CSV URL: any public CSV sample (model: gpt-5-mini)

### Local files (LLM summary, 4)

17. `tests/fixtures/sample.txt` (create if missing) (model: gemini-3-flash)
18. `tests/fixtures/sample.md` (create if missing) (model: gpt-5-mini)
19. `tests/fixtures/sample.json` (create if missing) (model: gemini-3-flash)
20. `tests/fixtures/sample.png` (create if missing; use a real PNG, not 1x1) (model: gpt-5-mini)

## Commands (template)

- Website: `pnpm summarize -- "<url>" --model <model> --length short`
- YouTube: `pnpm summarize -- "<url>" --model <model> --youtube auto`
- File URL: `pnpm summarize -- "<url>" --model <model>`
- Local file: `pnpm summarize -- "<path>" --model <model>`

## Capture

- Log: stdout + stderr, exit code, and timing line.
- Note extraction path (HTML vs Firecrawl vs YouTube transcript).
- File errors: media type rejection, size limits, token preflight.

## Bug bar

- Crash, hang, or non-zero exit.
- Empty summary with non-empty input.
- Incorrect mode selection (e.g., YouTube treated as normal URL).
- Wrong fallback behavior or misleading error text.

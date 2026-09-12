import { type LinkPreviewProgressEvent, ProgressKind } from "@steipete/summarize-core/content";
import { describe, expect, it } from "vitest";
import { formatProgress } from "../src/daemon/summarize-progress.js";

describe("daemon/summarize-progress", () => {
  it("formats link preview progress events", () => {
    const service = "YouTube";

    const cases: Array<[LinkPreviewProgressEvent, string | null]> = [
      [{ kind: ProgressKind.FetchHtmlStart } as LinkPreviewProgressEvent, "Fetching…"],
      [
        { kind: ProgressKind.FirecrawlStart, reason: "blocked" } as LinkPreviewProgressEvent,
        "Firecrawl… (blocked)",
      ],
      [
        { kind: ProgressKind.FirecrawlDone, ok: true } as LinkPreviewProgressEvent,
        "Firecrawl: done",
      ],
      [
        { kind: ProgressKind.FirecrawlDone, ok: false } as LinkPreviewProgressEvent,
        "Firecrawl: failed",
      ],
      [
        { kind: ProgressKind.TranscriptStart, hint: "Captions…" } as LinkPreviewProgressEvent,
        "Captions…",
      ],
      [{ kind: ProgressKind.TranscriptStart, hint: "" } as LinkPreviewProgressEvent, "Transcript…"],
      [
        { kind: ProgressKind.TranscriptMediaDownloadStart, service } as LinkPreviewProgressEvent,
        `${service}: downloading audio…`,
      ],
      [
        { kind: ProgressKind.TranscriptMediaDownloadProgress, service } as LinkPreviewProgressEvent,
        `${service}: downloading audio…`,
      ],
      [
        {
          kind: ProgressKind.TranscriptMediaDownloadProgress,
          service,
          downloadedBytes: 50,
          totalBytes: 100,
        } as LinkPreviewProgressEvent,
        `${service}: downloading audio… 50%`,
      ],
      [
        { kind: ProgressKind.TranscriptWhisperStart, service } as LinkPreviewProgressEvent,
        `${service}: transcribing…`,
      ],
      [
        { kind: ProgressKind.TranscriptWhisperProgress, service } as LinkPreviewProgressEvent,
        `${service}: transcribing…`,
      ],
      [
        {
          kind: ProgressKind.TranscriptWhisperProgress,
          service,
          processedDurationSeconds: 5,
          totalDurationSeconds: 10,
        } as LinkPreviewProgressEvent,
        `${service}: transcribing… 50%`,
      ],
      [
        { kind: ProgressKind.TranscriptDone, service, ok: true } as LinkPreviewProgressEvent,
        `${service}: transcript ready`,
      ],
      [
        { kind: ProgressKind.TranscriptDone, service, ok: false } as LinkPreviewProgressEvent,
        `${service}: transcript unavailable`,
      ],
      [{ kind: ProgressKind.BirdStart } as LinkPreviewProgressEvent, "X: extracting tweet…"],
      [
        { kind: ProgressKind.BirdStart, client: "xurl" } as LinkPreviewProgressEvent,
        "X: extracting tweet (xurl)…",
      ],
      [{ kind: ProgressKind.BirdDone, ok: true } as LinkPreviewProgressEvent, "X: extracted tweet"],
      [{ kind: ProgressKind.BirdDone, ok: false } as LinkPreviewProgressEvent, "X: extract failed"],
      [
        { kind: ProgressKind.NitterStart } as LinkPreviewProgressEvent,
        "X: extracting tweet (nitter)…",
      ],
      [
        { kind: ProgressKind.NitterDone, ok: true } as LinkPreviewProgressEvent,
        "X: extracted tweet",
      ],
      [
        { kind: ProgressKind.NitterDone, ok: false } as LinkPreviewProgressEvent,
        "X: extract failed",
      ],
      [
        { kind: ProgressKind.TwitterSyndicationStart } as LinkPreviewProgressEvent,
        "X: extracting tweet (syndication API)…",
      ],
      [
        { kind: ProgressKind.TwitterSyndicationDone, ok: true } as LinkPreviewProgressEvent,
        "X: extracted tweet",
      ],
      [
        { kind: ProgressKind.TwitterSyndicationDone, ok: false } as LinkPreviewProgressEvent,
        "X: extract failed",
      ],
      [{ kind: "unknown" as unknown as ProgressKind } as LinkPreviewProgressEvent, null],
    ];

    for (const [evt, expected] of cases) {
      expect(formatProgress(evt)).toBe(expected);
    }
  });
});

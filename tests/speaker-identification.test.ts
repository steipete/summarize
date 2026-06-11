import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtractedLinkContent } from "../packages/core/src/content/link-preview/content/types.js";
import type { TranscriptSegment } from "../packages/core/src/content/link-preview/types.js";
import { hashJson } from "../src/cache-keys.js";
import { loadSummarizeConfig } from "../src/config.js";
import {
  identifySpeakersInExtractedContent,
  parseSpeakerAnchor,
  rememberSpeakerMappings,
  resolveSpeakerIdentificationSettings,
  type SpeakerIdentificationSettings,
} from "../src/speaker-identification/index.js";

const segments: TranscriptSegment[] = [
  {
    startMs: 0,
    endMs: 1_200,
    text: "Welcome back to Modern Wisdom.",
    speaker: "Speaker 1",
  },
  {
    startMs: 1_200,
    endMs: 2_200,
    text: "Thanks for having me, Chris.",
    speaker: "Speaker 2",
  },
];

const settings = (
  overrides: Partial<SpeakerIdentificationSettings> = {},
): SpeakerIdentificationSettings => ({
  sourceKey: "youtube:abcdefghijk",
  profileName: "modern-wisdom",
  host: "Chris Williamson",
  knownSpeakers: ["Chris Williamson", "Joe Santagato"],
  context: "Modern Wisdom podcast",
  model: "openai/gpt-5.5",
  minimumConfidence: 0.85,
  anchors: [],
  remembered: null,
  remember: false,
  explicit: true,
  ...overrides,
});

function extractedContent(): ExtractedLinkContent {
  return {
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    title: "The Art of Unstoppable Self-Belief",
    description: "Chris Williamson talks with Joe Santagato.",
    siteName: "YouTube",
    content: "Speaker 1: Welcome back to Modern Wisdom.\nSpeaker 2: Thanks for having me, Chris.",
    truncated: false,
    totalCharacters: 86,
    wordCount: 14,
    transcriptCharacters: 86,
    transcriptLines: 2,
    transcriptWordCount: 14,
    transcriptSource: "whisper",
    transcriptionProvider: "elevenlabs",
    transcriptMetadata: { segments },
    transcriptSegments: segments,
    transcriptTimedText:
      "[0:00] Speaker 1: Welcome back to Modern Wisdom.\n[0:01] Speaker 2: Thanks for having me, Chris.",
    mediaDurationSeconds: 3,
    video: { kind: "youtube", url: "https://www.youtube.com/watch?v=abcdefghijk" },
    isVideoOnly: false,
    diagnostics: {
      strategy: "html",
      firecrawl: {
        attempted: false,
        used: false,
        cacheMode: "default",
        cacheStatus: "bypassed",
      },
      markdown: { requested: false, used: false, provider: null },
      transcript: {
        cacheMode: "default",
        cacheStatus: "miss",
        textProvided: true,
        provider: "whisper",
        attemptedProviders: ["whisper"],
      },
    },
  };
}

describe("speaker identification settings", () => {
  it("parses timestamp anchors", () => {
    expect(parseSpeakerAnchor("01:23.5=Chris Williamson")).toEqual({
      atMs: 83_500,
      name: "Chris Williamson",
    });
    expect(() => parseSpeakerAnchor("Chris Williamson")).toThrow(/timestamp=name/);
  });

  it("merges source and CLI anchors with profile defaults", () => {
    const result = resolveSpeakerIdentificationSettings({
      config: {
        defaultProfile: "modern-wisdom",
        autoIdentify: true,
        profiles: {
          "modern-wisdom": {
            host: "Chris Williamson",
            knownSpeakers: ["Joe Santagato"],
            model: "gpt-5.5",
          },
        },
        sources: {
          "youtube:abcdefghijk": {
            profile: "modern-wisdom",
            anchors: [{ at: "0:01", name: "Joe Santagato" }],
          },
        },
      },
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      diarization: "elevenlabs",
      profileArg: null,
      anchorArgs: ["0:00=Chris Williamson"],
      identifyOverride: null,
      remember: false,
    });

    expect(result).toMatchObject({
      sourceKey: "youtube:abcdefghijk",
      profileName: "modern-wisdom",
      host: "Chris Williamson",
      knownSpeakers: ["Chris Williamson", "Joe Santagato"],
      model: "openai/gpt-5.5",
      anchors: [
        { atMs: 0, name: "Chris Williamson" },
        { atMs: 1_000, name: "Joe Santagato" },
      ],
    });
  });

  it("requires diarization for explicit identification", () => {
    expect(() =>
      resolveSpeakerIdentificationSettings({
        config: undefined,
        sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
        diarization: null,
        profileArg: null,
        anchorArgs: [],
        identifyOverride: true,
        remember: false,
      }),
    ).toThrow(/requires --diarize/);
  });

  it("lets a profile disable global automatic identification", () => {
    expect(
      resolveSpeakerIdentificationSettings({
        config: {
          autoIdentify: true,
          defaultProfile: "private",
          profiles: { private: { autoIdentify: false } },
        },
        sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
        diarization: "elevenlabs",
        profileArg: null,
        anchorArgs: [],
        identifyOverride: null,
        remember: false,
      }),
    ).toBeNull();
  });

  it("does not reuse remembered identity from a different profile", () => {
    const result = resolveSpeakerIdentificationSettings({
      config: {
        profiles: {
          original: { host: "Original Host" },
          alternate: { host: "Alternate Host" },
        },
        sources: {
          "youtube:abcdefghijk": {
            profile: "original",
            anchors: [{ at: "0:01", name: "Original Host" }],
            transcriptHash: "a".repeat(64),
            mappings: { "Speaker 1": "Original Host" },
          },
        },
      },
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      diarization: "elevenlabs",
      profileArg: "alternate",
      anchorArgs: [],
      identifyOverride: null,
      remember: false,
    });

    expect(result).toMatchObject({
      profileName: "alternate",
      host: "Alternate Host",
      anchors: [],
      remembered: null,
    });
  });
});

describe("speaker identification", () => {
  it("uses authoritative anchors before OpenAI context inference", async () => {
    const inferMappings = vi.fn(async (input) => {
      expect(input.unresolvedSpeakers).toEqual(["Speaker 2"]);
      expect(input.anchoredMappings).toEqual({ "Speaker 1": "Chris Williamson" });
      return {
        mappings: [
          {
            speaker: "Speaker 2",
            name: "Joe Santagato",
            confidence: 0.97,
            evidence: "The guest addresses Chris by name.",
          },
        ],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
    });

    const result = await identifySpeakersInExtractedContent({
      extracted: extractedContent(),
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      settings: settings({ anchors: [{ atMs: 500, name: "Chris Williamson" }] }),
      openaiApiKey: "test-key",
      openaiBaseUrl: null,
      timeoutMs: 1_000,
      maxContentCharacters: null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      inferMappings,
    });

    expect(result.warning).toBeNull();
    expect(result.cacheable).toBe(true);
    expect(result.mappings).toEqual([
      expect.objectContaining({
        speaker: "Speaker 1",
        name: "Chris Williamson",
        source: "anchor",
      }),
      expect.objectContaining({
        speaker: "Speaker 2",
        name: "Joe Santagato",
        source: "openai",
      }),
    ]);
    expect(result.extracted.content).toContain("Chris Williamson: Welcome back");
    expect(result.extracted.content).toContain("Joe Santagato: Thanks for having me");
    expect(result.extracted.transcriptTimedText).toContain("[0:01] Joe Santagato:");
    expect(result.extracted.transcriptSegments).toEqual([
      expect.objectContaining({ speaker: "Chris Williamson" }),
      expect.objectContaining({ speaker: "Joe Santagato" }),
    ]);
    expect(result.extracted.transcriptMetadata?.speakerIdentification).toMatchObject({
      status: "complete",
      model: "openai/gpt-5.5",
      unresolved: [],
    });
  });

  it("keeps low-confidence labels generic and caches the stable partial result", async () => {
    const result = await identifySpeakersInExtractedContent({
      extracted: extractedContent(),
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      settings: settings({ anchors: [{ atMs: 500, name: "Chris Williamson" }] }),
      openaiApiKey: "test-key",
      openaiBaseUrl: null,
      timeoutMs: 1_000,
      maxContentCharacters: null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      inferMappings: vi.fn(async () => ({
        mappings: [
          {
            speaker: "Speaker 2",
            name: "Joe Santagato",
            confidence: 0.5,
            evidence: "Weak contextual guess.",
          },
        ],
        usage: null,
      })),
    });

    expect(result.cacheable).toBe(true);
    expect(result.mappings).toHaveLength(1);
    expect(result.extracted.content).toContain("Speaker 2: Thanks for having me");
    expect(result.extracted.transcriptMetadata?.speakerIdentification).toMatchObject({
      status: "partial",
      unresolved: ["Speaker 2"],
    });
  });

  it("selects the speaker whose segment starts at an exact boundary", async () => {
    const result = await identifySpeakersInExtractedContent({
      extracted: extractedContent(),
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      settings: settings({ anchors: [{ atMs: 1_200, name: "Joe Santagato" }] }),
      openaiApiKey: null,
      openaiBaseUrl: null,
      timeoutMs: 1_000,
      maxContentCharacters: null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result.mappings).toEqual([
      expect.objectContaining({ speaker: "Speaker 2", name: "Joe Santagato" }),
    ]);
  });

  it("reapplies the extraction character budget after names expand labels", async () => {
    const result = await identifySpeakersInExtractedContent({
      extracted: extractedContent(),
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      settings: settings({
        anchors: [
          { atMs: 0, name: "Christopher Williamson" },
          { atMs: 1_200, name: "Joseph Patrick Santagato" },
        ],
      }),
      openaiApiKey: null,
      openaiBaseUrl: null,
      timeoutMs: 1_000,
      maxContentCharacters: 60,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result.extracted.content.length).toBeLessThanOrEqual(60);
    expect(result.extracted.truncated).toBe(true);
    expect(result.extracted.totalCharacters).toBeGreaterThan(60);
  });

  it("applies remembered mappings only to the exact transcript hash", async () => {
    const exact = await identifySpeakersInExtractedContent({
      extracted: extractedContent(),
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      settings: settings({
        remembered: {
          transcriptHash: hashJson(segments).toUpperCase(),
          mappings: {
            "Speaker 1": "Chris Williamson",
            "Speaker 2": "Joe Santagato",
          },
        },
      }),
      openaiApiKey: null,
      openaiBaseUrl: null,
      timeoutMs: 1_000,
      maxContentCharacters: null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(exact.warning).toBeNull();
    expect(exact.mappings.every((mapping) => mapping.source === "remembered")).toBe(true);

    const stale = await identifySpeakersInExtractedContent({
      extracted: extractedContent(),
      sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
      settings: settings({
        remembered: { transcriptHash: "0".repeat(64), mappings: { "Speaker 1": "Wrong Name" } },
      }),
      openaiApiKey: null,
      openaiBaseUrl: null,
      timeoutMs: 1_000,
      maxContentCharacters: null,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(stale.mappings).toEqual([]);
    expect(stale.warning).toMatch(/OPENAI_API_KEY/);
    expect(stale.extracted.content).toContain("Speaker 1:");
    expect(stale.cacheable).toBe(false);
  });
});

describe("speaker identity config", () => {
  it("loads profiles and rejects mappings without a transcript hash", () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-speakers-config-"));
    const configDir = join(root, ".summarize");
    const configPath = join(configDir, "config.json");
    mkdirSync(configDir, { recursive: true });
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          speakers: {
            defaultProfile: "modern-wisdom",
            autoIdentify: true,
            profiles: { "modern-wisdom": { host: "Chris Williamson" } },
          },
        }),
      );
      expect(loadSummarizeConfig({ env: { HOME: root } }).config?.speakers).toMatchObject({
        defaultProfile: "modern-wisdom",
        autoIdentify: true,
      });

      writeFileSync(
        configPath,
        JSON.stringify({
          speakers: {
            sources: { "youtube:abcdefghijk": { mappings: { "Speaker 1": "Chris" } } },
          },
        }),
      );
      expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
        /transcriptHash.*mappings.*together/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically remembers names while preserving unrelated config", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-speakers-remember-"));
    const configPath = join(root, "config.json");
    try {
      writeFileSync(configPath, `${JSON.stringify({ model: "auto", custom: { keep: true } })}\n`);
      chmodSync(configPath, 0o640);
      await rememberSpeakerMappings({
        configPath,
        settings: settings({ anchors: [{ atMs: 500, name: "Chris Williamson" }] }),
        mappings: [
          { speaker: "Speaker 1", name: "Chris Williamson", confidence: 1, source: "anchor" },
          { speaker: "Speaker 2", name: "Joe Santagato", confidence: 0.97, source: "openai" },
        ],
        transcriptHash: "a".repeat(64),
      });

      const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
      expect(stored.custom).toEqual({ keep: true });
      expect(stored.speakers.profiles["modern-wisdom"].knownSpeakers).toEqual([
        "Chris Williamson",
        "Joe Santagato",
      ]);
      expect(stored.speakers.sources["youtube:abcdefghijk"]).toMatchObject({
        profile: "modern-wisdom",
        anchors: [{ at: "0:00.5", name: "Chris Williamson" }],
        transcriptHash: "a".repeat(64),
        mappings: {
          "Speaker 1": "Chris Williamson",
          "Speaker 2": "Joe Santagato",
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops source anchors when remembering under a different profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-speakers-profile-switch-"));
    const configPath = join(root, "config.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          speakers: {
            profiles: { original: {}, alternate: {} },
            sources: {
              "youtube:abcdefghijk": {
                profile: "original",
                anchors: [{ at: "0:01", name: "Original Host" }],
                transcriptHash: "b".repeat(64),
                mappings: { "Speaker 1": "Original Host" },
                note: "preserve me",
              },
            },
          },
        }),
      );

      await rememberSpeakerMappings({
        configPath,
        settings: settings({
          profileName: "alternate",
          anchors: [{ atMs: 1_200, name: "Alternate Host" }],
        }),
        mappings: [
          {
            speaker: "Speaker 2",
            name: "Alternate Host",
            confidence: 1,
            source: "anchor",
          },
        ],
        transcriptHash: "c".repeat(64),
      });

      const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
      expect(stored.speakers.sources["youtube:abcdefghijk"]).toEqual({
        profile: "alternate",
        anchors: [{ at: "0:01.2", name: "Alternate Host" }],
        transcriptHash: "c".repeat(64),
        mappings: { "Speaker 2": "Alternate Host" },
        note: "preserve me",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent config updates without losing either source", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-speakers-concurrent-"));
    const configPath = join(root, "config.json");
    try {
      writeFileSync(configPath, "{}\n");
      await Promise.all([
        rememberSpeakerMappings({
          configPath,
          settings: settings({
            sourceKey: "youtube:firstvideo1",
            profileName: "first-show",
          }),
          mappings: [{ speaker: "Speaker 1", name: "First Host", confidence: 1, source: "anchor" }],
          transcriptHash: "1".repeat(64),
        }),
        rememberSpeakerMappings({
          configPath,
          settings: settings({
            sourceKey: "youtube:secondvide2",
            profileName: "second-show",
          }),
          mappings: [
            { speaker: "Speaker 1", name: "Second Host", confidence: 1, source: "anchor" },
          ],
          transcriptHash: "2".repeat(64),
        }),
      ]);

      const stored = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
      expect(Object.keys(stored.speakers.profiles).sort()).toEqual(["first-show", "second-show"]);
      expect(Object.keys(stored.speakers.sources).sort()).toEqual([
        "youtube:firstvideo1",
        "youtube:secondvide2",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to replace a symlinked config", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-speakers-symlink-"));
    const target = join(root, "target.json");
    const configPath = join(root, "config.json");
    try {
      writeFileSync(target, "{}\n");
      symlinkSync(target, configPath);
      await expect(
        rememberSpeakerMappings({
          configPath,
          settings: settings(),
          mappings: [
            {
              speaker: "Speaker 1",
              name: "Chris Williamson",
              confidence: 1,
              source: "anchor",
            },
          ],
          transcriptHash: "a".repeat(64),
        }),
      ).rejects.toThrow(/symlinked config/);
      expect(readFileSync(target, "utf8")).toBe("{}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to replace an existing config that cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-speakers-unreadable-"));
    const configPath = join(root, "config.json");
    try {
      mkdirSync(configPath);
      await expect(
        rememberSpeakerMappings({
          configPath,
          settings: settings(),
          mappings: [
            {
              speaker: "Speaker 1",
              name: "Chris Williamson",
              confidence: 1,
              source: "anchor",
            },
          ],
          transcriptHash: "a".repeat(64),
        }),
      ).rejects.toThrow(/Unable to read existing config.*refusing to replace/);
      expect(statSync(configPath).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

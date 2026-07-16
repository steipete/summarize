import { describe, expect, it } from "vitest";
import {
  parseDiarizationMode,
  parseDurationMs,
  parseEmbeddedVideoMode,
  parseExtractFormat,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseMaxExtractCharactersArg,
  parseMaxOutputTokensArg,
  parseMetricsMode,
  parsePreprocessMode,
  parseRetriesArg,
  parseStreamMode,
  parseYoutubeMode,
} from "../src/flags.js";
import { buildProgram } from "../src/run/help.js";
import { resolveRunnerFlags } from "../src/run/runner-flags.js";
import { normalizeDiarizeArgv, prepareRunEnvironment } from "../src/run/runner-setup.js";

describe("cli flag parsing", () => {
  it("defaults summary length to long", () => {
    const program = buildProgram();
    program.parse(["https://example.com"], { from: "user" });

    expect(program.opts().length).toBe("long");
  });

  it("parses --diarize", () => {
    expect(parseDiarizationMode("auto")).toBe("auto");
    expect(parseDiarizationMode("elevenlabs")).toBe("elevenlabs");
    expect(parseDiarizationMode("openai")).toBe("openai");
    expect(() => parseDiarizationMode("nope")).toThrow(/Unsupported --diarize/);
  });

  it("treats a URL after bare --diarize as the positional input", () => {
    const url = "https://www.youtube.com/watch?v=abcdefghijk";
    const argv = normalizeDiarizeArgv(["--diarize", url]);
    const program = buildProgram();
    program.parse(argv, { from: "user" });

    expect(argv).toEqual(["--diarize=auto", url]);
    expect(program.opts().diarize).toBe("auto");
    expect(program.args).toEqual([url]);
  });

  it.each(["recording.mp3", "/tmp/interview.mp4"])(
    "treats %s after bare --diarize as the positional input",
    (input) => {
      const argv = normalizeDiarizeArgv(["--diarize", input]);
      const program = buildProgram();
      program.parse(argv, { from: "user" });

      expect(argv).toEqual(["--diarize=auto", input]);
      expect(program.opts().diarize).toBe("auto");
      expect(program.args).toEqual([input]);
    },
  );

  it("keeps explicit diarization providers intact", () => {
    const url = "https://www.youtube.com/watch?v=abcdefghijk";
    expect(normalizeDiarizeArgv(["--diarize", "openai", url])).toEqual([
      "--diarize",
      "openai",
      url,
    ]);
  });

  it("keeps bare --diarize unchanged when no positional input follows", () => {
    expect(normalizeDiarizeArgv(["--diarize"])).toEqual(["--diarize"]);
  });

  it("parses speaker identity profiles and repeatable timestamp anchors", () => {
    const program = buildProgram();
    program.parse(
      [
        "--diarize=elevenlabs",
        "--identify-speakers",
        "--speaker-profile",
        "modern-wisdom",
        "--speaker-at",
        "0:12=Chris Williamson",
        "--speaker-at",
        "1:42=Joe Santagato",
        "--remember-speakers",
        "https://www.youtube.com/watch?v=abcdefghijk",
      ],
      { from: "user" },
    );

    expect(program.opts()).toMatchObject({
      diarize: "elevenlabs",
      identifySpeakers: true,
      speakerProfile: "modern-wisdom",
      speakerAt: ["0:12=Chris Williamson", "1:42=Joe Santagato"],
      rememberSpeakers: true,
    });
  });

  it("parses --no-identify-speakers without enabling identification by default", () => {
    const defaultProgram = buildProgram();
    defaultProgram.parse(["https://www.youtube.com/watch?v=abcdefghijk"], { from: "user" });
    expect(defaultProgram.opts().identifySpeakers).toBeUndefined();

    const disabledProgram = buildProgram();
    disabledProgram.parse(
      ["--no-identify-speakers", "https://www.youtube.com/watch?v=abcdefghijk"],
      { from: "user" },
    );
    expect(disabledProgram.opts().identifySpeakers).toBe(false);
  });

  it("parses --youtube", () => {
    expect(parseYoutubeMode("auto")).toBe("auto");
    expect(parseYoutubeMode("web")).toBe("web");
    expect(parseYoutubeMode("apify")).toBe("apify");
    expect(parseYoutubeMode("yt-dlp")).toBe("yt-dlp");
    expect(parseYoutubeMode("autp")).toBe("auto");
    expect(() => parseYoutubeMode("nope")).toThrow(/Unsupported --youtube/);
  });

  it("parses --embedded-video", () => {
    expect(parseEmbeddedVideoMode("auto")).toBe("auto");
    expect(parseEmbeddedVideoMode("off")).toBe("off");
    expect(parseEmbeddedVideoMode("prefer")).toBe("prefer");
    expect(parseEmbeddedVideoMode("both")).toBe("both");
    expect(() => parseEmbeddedVideoMode("nope")).toThrow(/Unsupported --embedded-video/);
  });

  it("parses --timeout durations", () => {
    expect(parseDurationMs("30")).toBe(30_000);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("2m")).toBe(120_000);
    expect(parseDurationMs("500ms")).toBe(500);
    expect(() => parseDurationMs("0")).toThrow(/Unsupported --timeout/);
  });

  it("parses --firecrawl", () => {
    expect(parseFirecrawlMode("off")).toBe("off");
    expect(parseFirecrawlMode("auto")).toBe("auto");
    expect(parseFirecrawlMode("always")).toBe("always");
    expect(() => parseFirecrawlMode("nope")).toThrow(/Unsupported --firecrawl/);
  });

  it("parses --markdown-mode", () => {
    expect(parseMarkdownMode("off")).toBe("off");
    expect(parseMarkdownMode("auto")).toBe("auto");
    expect(parseMarkdownMode("llm")).toBe("llm");
    expect(() => parseMarkdownMode("nope")).toThrow(/Unsupported --markdown-mode/);
  });

  it("parses --format", () => {
    expect(parseExtractFormat("md")).toBe("markdown");
    expect(parseExtractFormat("markdown")).toBe("markdown");
    expect(parseExtractFormat("text")).toBe("text");
    expect(parseExtractFormat("plain")).toBe("text");
    expect(() => parseExtractFormat("nope")).toThrow(/Unsupported --format/);
  });

  it("parses --preprocess", () => {
    expect(parsePreprocessMode("off")).toBe("off");
    expect(parsePreprocessMode("auto")).toBe("auto");
    expect(parsePreprocessMode("always")).toBe("always");
    expect(parsePreprocessMode("on")).toBe("always");
    expect(() => parsePreprocessMode("nope")).toThrow(/Unsupported --preprocess/);
  });

  it("parses --stream", () => {
    expect(parseStreamMode("auto")).toBe("auto");
    expect(parseStreamMode("on")).toBe("on");
    expect(parseStreamMode("off")).toBe("off");
    expect(() => parseStreamMode("nope")).toThrow(/Unsupported --stream/);
  });

  it("parses --metrics", () => {
    expect(parseMetricsMode("on")).toBe("on");
    expect(parseMetricsMode("off")).toBe("off");
    expect(parseMetricsMode("detailed")).toBe("detailed");
    expect(() => parseMetricsMode("nope")).toThrow(/Unsupported --metrics/);
  });

  it("parses --length as preset or character count", () => {
    expect(parseLengthArg("medium")).toEqual({ kind: "preset", preset: "medium" });
    expect(parseLengthArg("20k")).toEqual({ kind: "chars", maxCharacters: 20_000 });
    expect(parseLengthArg("1500")).toEqual({ kind: "chars", maxCharacters: 1500 });
    expect(parseLengthArg("50")).toEqual({ kind: "chars", maxCharacters: 50 });
    expect(parseLengthArg("10")).toEqual({ kind: "chars", maxCharacters: 10 });
    expect(() => parseLengthArg("1")).toThrow(/Unsupported --length/);
    expect(() => parseLengthArg("9")).toThrow(/Unsupported --length/);
    expect(() => parseLengthArg("nope")).toThrow(/Unsupported --length/);
  });

  it("parses --max-output-tokens", () => {
    expect(parseMaxOutputTokensArg(undefined)).toBeNull();
    expect(parseMaxOutputTokensArg("2k")).toBe(2000);
    expect(parseMaxOutputTokensArg("1500")).toBe(1500);
    expect(parseMaxOutputTokensArg("16")).toBe(16);
    expect(() => parseMaxOutputTokensArg("1")).toThrow(/Unsupported --max-output-tokens/);
    expect(() => parseMaxOutputTokensArg("15")).toThrow(/Unsupported --max-output-tokens/);
    expect(() => parseMaxOutputTokensArg("nope")).toThrow(/Unsupported --max-output-tokens/);
  });

  it("parses --max-extract-characters", () => {
    expect(parseMaxExtractCharactersArg(undefined)).toBeNull();
    expect(parseMaxExtractCharactersArg("0")).toBeNull();
    expect(parseMaxExtractCharactersArg("8k")).toBe(8000);
    expect(parseMaxExtractCharactersArg("15000")).toBe(15000);
    expect(() => parseMaxExtractCharactersArg("5")).toThrow(/max-extract-characters/);
    expect(() => parseMaxExtractCharactersArg("nope")).toThrow(/max-extract-characters/);
  });

  it("parses --retries", () => {
    expect(parseRetriesArg("0")).toBe(0);
    expect(parseRetriesArg("3")).toBe(3);
    expect(() => parseRetriesArg("1e0")).toThrow(/Unsupported --retries/);
    expect(() => parseRetriesArg("0x2")).toThrow(/Unsupported --retries/);
    expect(() => parseRetriesArg("2.0")).toThrow(/Unsupported --retries/);
    expect(() => parseRetriesArg("-1")).toThrow(/Unsupported --retries/);
  });

  it("does not apply YouTube defaults to lookalike hostnames", () => {
    const url = "https://notyoutube.com/watch?v=abcdefghijk";
    const normalizedArgv = ["--extract", url];
    const program = buildProgram();
    program.parse(normalizedArgv, { from: "user" });

    const flags = resolveRunnerFlags({
      normalizedArgv,
      programOpts: program.opts() as Record<string, unknown>,
      envForRun: {},
      url,
    });

    expect(flags.isYoutubeUrl).toBe(false);
    expect(flags.format).toBe("markdown");
  });

  it("accepts dash-prefixed inputs after the end-of-options separator", () => {
    const { normalizedArgv, preSeparatorArgv } = prepareRunEnvironment(
      ["--extract", "--", "--format=.pdf"],
      {},
    );
    const program = buildProgram();
    program.parse(normalizedArgv, { from: "user" });

    expect(program.args).toEqual(["--format=.pdf"]);
    expect(
      resolveRunnerFlags({
        normalizedArgv: preSeparatorArgv,
        programOpts: program.opts() as Record<string, unknown>,
        envForRun: {},
        url: null,
      }).format,
    ).toBe("markdown");
  });
});

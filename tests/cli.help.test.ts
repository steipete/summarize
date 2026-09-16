import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { availableUiLocales } from "@steipete/summarize-core/localization/messages";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import { applyHelpStyle, buildProgram, buildSlidesProgram } from "../src/run/help.js";

const collectStream = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
};

describe("--help output", () => {
  it.each([buildProgram, buildSlidesProgram])(
    "preserves localized descriptions when styling %s",
    (build) => {
      const program = build("tr");
      const original = program.configureHelp();
      const stdout = collectStream();
      applyHelpStyle(program, { FORCE_COLOR: "1", SUMMARIZE_LOCALE: "tr" }, stdout.stream);
      expect(program.configureHelp().optionDescription).toBe(original.optionDescription);
      expect(program.configureHelp().argumentDescription).toBe(original.argumentDescription);
      const help = stripVTControlCharacters(program.helpInformation());
      expect(help).toContain("seçenekler:");
      expect(help).toContain("varsayılan:");
      expect(help).not.toContain("choices:");
      expect(help).not.toContain("default:");
    },
  );
  it("advertises exactly the registered interface locales", () => {
    const option = buildProgram("en").options.find((item) => item.long === "--locale");
    const list = new Intl.ListFormat("en", { type: "disjunction" }).format([
      "auto",
      ...availableUiLocales,
    ]);
    expect(option?.description).toBe(
      `UI language: ${list}. auto follows the system (also SUMMARIZE_LOCALE). Independent of --language.`,
    );
  });
  it("prints examples without ANSI when not a TTY", async () => {
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--help"], {
      env: { TERM: "xterm-256color" },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const out = stdout.getText();
    expect(out).toContain("Examples");
    expect(out).toContain('summarize "https://example.com"');
    expect(out).toContain("--embedded-video <mode>");
    expect(out).toContain("Local transcription stage");
    expect(out).toMatch(/Groq still runs\s+first when keyed/);
    expect(out).not.toContain("Audio transcription backend");
    expect(out).toContain("default: long");
    expect(out).not.toContain("\u001b[");
  });

  it("uses ANSI color when stdout is a rich TTY", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    (stdout.stream as unknown as { isTTY?: boolean }).isTTY = true;

    await runCli(["--help"], {
      env: { TERM: "xterm-256color" },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const out = stdout.getText();
    expect(out).toContain("Examples");
    expect(out).toContain('summarize "https://example.com"');
    expect(out).toContain("Env Vars");
  });

  it("prints refresh-free options supported by the CLI parser", async () => {
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["refresh-free", "--help"], {
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const out = stdout.getText();
    expect(out).toContain("Usage: summarize refresh-free");
    expect(out).toContain("--max-age-days 180");
    expect(out).toContain("--set-default");
    expect(stderr.getText()).toBe("");
  });
});

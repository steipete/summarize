import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  parseExtractFormat,
  parseFirecrawlMode,
  parseMarkdownMode,
  parseStreamMode,
  parseYoutubeMode,
} from "../src/flags.js";
import { buildProgram, buildSlidesProgram } from "../src/run/help.js";

const completedChoiceValues = (fish: string, condition: string, longOption: string): string[] => {
  const line = fish
    .split("\n")
    .find(
      (candidate) =>
        candidate.includes(`-n '${condition}'`) &&
        new RegExp(`(?:^|\\s)-l\\s+${longOption}(?:\\s|$)`).test(candidate),
    );
  expect(line, `missing Fish completion for --${longOption}`).toBeDefined();

  const literal = line?.match(/(?:^|\s)-xa\s+'([^']*)'/)?.[1];
  if (literal) return literal.trim().split(/\s+/);

  const variable = line?.match(/(?:^|\s)-xa\s+"\$([a-z0-9_]+)"/i)?.[1];
  expect(variable, `missing Fish candidates for --${longOption}`).toBeDefined();
  const declaration = fish.match(new RegExp(`^set\\s+-g\\s+${variable}\\s+(.+)$`, "m"))?.[1];
  expect(declaration, `missing Fish candidate variable ${variable}`).toBeDefined();
  return declaration?.trim().split(/\s+/) ?? [];
};

describe("package bin wrappers", () => {
  it("writes an executable dist wrapper that runs the ESM CLI entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-bin-"));
    try {
      const distDir = join(root, "dist");
      await mkdir(join(distDir, "esm"), { recursive: true });
      await writeFile(
        join(distDir, "esm", "cli.js"),
        "if (process.argv.includes('--version')) process.stdout.write('0.0.0-test\\n');\n",
        "utf8",
      );

      const buildCli = (await import("../scripts/build-cli.mjs")) as {
        writeCliWrapper: (distDir: string) => Promise<string>;
      };
      const wrapperPath = await buildCli.writeCliWrapper(distDir);
      const wrapper = await readFile(wrapperPath, "utf8");
      const mode = statSync(wrapperPath).mode;

      expect(wrapper.startsWith("#!/usr/bin/env node\n")).toBe(true);
      if (process.platform !== "win32") expect(mode & 0o111).not.toBe(0);

      const result = spawnSync(
        process.platform === "win32" ? process.execPath : wrapperPath,
        process.platform === "win32" ? [wrapperPath, "--version"] : ["--version"],
        {
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("0.0.0-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the generated package entry executable without a node prefix on POSIX", async () => {
    if (process.platform === "win32") return;

    const root = await mkdtemp(join(tmpdir(), "summarize-bin-direct-"));
    try {
      const distDir = join(root, "dist");
      await mkdir(join(distDir, "esm"), { recursive: true });
      await writeFile(
        join(distDir, "esm", "cli.js"),
        "if (process.argv.includes('--version')) process.stdout.write('0.0.0-direct\\n');\n",
        "utf8",
      );

      const buildCli = (await import("../scripts/build-cli.mjs")) as {
        writeCliWrapper: (distDir: string) => Promise<string>;
      };
      const wrapperPath = await buildCli.writeCliWrapper(distDir);
      const result = spawnSync(wrapperPath, ["--version"], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("0.0.0-direct");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the summarizer alias pointed at the same dist wrapper", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(pkg.bin?.summarize).toBe("./dist/cli.js");
    expect(pkg.bin?.summarizer).toBe("./dist/cli.js");
  });

  it("ships fish completions in the npm package", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      files?: string[];
    };

    expect(pkg.files).toContain("completions");
  });

  it("keeps fish completions aligned with visible CLI options", async () => {
    const fish = await readFile("completions/summarize.fish", "utf8");
    const completedLongOptions = (condition: string) =>
      Array.from(
        new Set(
          fish
            .split("\n")
            .filter((line) => line.includes(`-n '${condition}'`))
            .flatMap((line) =>
              Array.from(line.matchAll(/(?:^|\s)-l\s+([a-z0-9-]+)/g), (match) => match[1]),
            ),
        ),
      );
    const visibleLongOptions = (program: ReturnType<typeof buildProgram>) =>
      program.options
        .filter((option) => !option.hidden)
        .flatMap((option) => option.flags.match(/--[a-z0-9-]+/g) ?? [])
        .map((flag) => flag.slice(2));

    expect(completedLongOptions("__summarize_no_subcommand")).toEqual(
      expect.arrayContaining(visibleLongOptions(buildProgram())),
    );
    expect(completedLongOptions("__summarize_command_is slides")).toEqual(
      expect.arrayContaining(visibleLongOptions(buildSlidesProgram())),
    );

    for (const [condition, program] of [
      ["__summarize_no_subcommand", buildProgram()],
      ["__summarize_command_is slides", buildSlidesProgram()],
    ] as const) {
      for (const option of program.options) {
        if (!option.long || !option.argChoices) continue;
        expect(completedChoiceValues(fish, condition, option.long.slice(2)).sort()).toEqual(
          [...option.argChoices].sort(),
        );
      }
    }

    for (const [longOption, parse] of [
      ["youtube", parseYoutubeMode],
      ["firecrawl", parseFirecrawlMode],
      ["format", parseExtractFormat],
      ["markdown-mode", parseMarkdownMode],
      ["stream", parseStreamMode],
    ] as const) {
      for (const value of completedChoiceValues(fish, "__summarize_no_subcommand", longOption)) {
        expect(() => parse(value), `invalid Fish candidate --${longOption} ${value}`).not.toThrow();
      }
    }
  });

  it("documents extract and local video support in visible help", () => {
    const mainHelp = buildProgram().helpInformation();
    expect(mainHelp).toMatch(/URLs,\s+media,\s+and local PDFs/);
    expect(mainHelp).toContain("stdin is unsupported");
    expect(mainHelp).toContain("or local video files");

    const slidesHelp = buildSlidesProgram().helpInformation();
    expect(slidesHelp).toContain("Usage: summarize slides [options] <source>");
    expect(slidesHelp).toMatch(/local\s+video\s+file/);
  });

  it("accepts negated slides flags for configured defaults", () => {
    const program = buildProgram();
    program.parse(["--no-slides", "--no-slides-ocr"], { from: "user" });

    expect(program.opts()).toMatchObject({ slides: false, slidesOcr: false });
  });

  it("routes fish subcommands from the first CLI argument", async () => {
    const fish = await readFile("completions/summarize.fish", "utf8");

    expect(fish).toContain('test "$tokens[2]" = "$argv[1]"');
    expect(fish).not.toContain("$tokens[2..-1]");
    expect(fish).toContain(
      "complete -c $cmd -n '__summarize_needs_subcommand' -xa \"$__summarize_commands\"",
    );
    expect(fish).toContain(
      "complete -c $cmd -n '__summarize_nested_command_is daemon install' -l dev",
    );
    expect(fish).toContain(
      "complete -c $cmd -n '__summarize_nested_command_is transcriber setup' -l model",
    );
  });
});

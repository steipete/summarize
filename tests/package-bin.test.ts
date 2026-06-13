import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { buildProgram, buildSlidesProgram } from "../src/run/help.js";

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
  });

  it("routes fish subcommands from the first CLI argument", async () => {
    const fish = await readFile("completions/summarize.fish", "utf8");

    expect(fish).toContain('test "$tokens[2]" = "$argv[1]"');
    expect(fish).not.toContain("$tokens[2..-1]");
  });
});

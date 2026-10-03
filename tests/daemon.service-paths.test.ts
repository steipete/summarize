import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDaemonProgramArguments } from "../src/daemon/cli-service.js";
import { resolveHomebrewServicePath } from "../src/daemon/service-paths.js";

describe.skipIf(process.platform === "win32")("Homebrew service paths", () => {
  let prefix: string;

  beforeEach(async () => {
    prefix = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "summarize-homebrew-")));
    await fs.mkdir(path.join(prefix, "opt"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(prefix, { recursive: true, force: true });
  });

  async function install(formula: string, version: string, relativePath: string) {
    const keg = path.join(prefix, "Cellar", formula, version);
    const file = path.join(keg, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, version);
    return { keg, file, opt: path.join(prefix, "opt", formula) };
  }

  it("keeps both daemon and native-host commands valid after replacing installed kegs", async () => {
    const cliRelative = "libexec/lib/node_modules/@steipete/summarize/dist/cli.js";
    const node = await install("node", "26.5.0_1", "bin/node");
    const cli = await install("summarize", "0.21.7", cliRelative);
    await fs.symlink(node.keg, node.opt, "junction");
    await fs.symlink(cli.keg, cli.opt, "junction");
    vi.spyOn(process, "execPath", "get").mockReturnValue(node.file);
    vi.spyOn(process, "argv", "get").mockReturnValue([node.file, cli.file]);

    const daemon = await resolveDaemonProgramArguments({ dev: false });
    const nativeHost = await resolveDaemonProgramArguments({
      dev: false,
      subcommand: "native-host",
    });
    expect(daemon.programArguments).toEqual([
      path.join(node.opt, "bin/node"),
      path.join(cli.opt, cliRelative),
      "daemon",
      "run",
    ]);
    expect(nativeHost.programArguments).toEqual([
      ...daemon.programArguments.slice(0, 3),
      "native-host",
    ]);

    for (const [previous, formula, relative] of [
      [node, "node", "bin/node"],
      [cli, "summarize", cliRelative],
    ] as const) {
      const next = await install(formula, "next", relative);
      await fs.unlink(previous.opt);
      await fs.symlink(next.keg, next.opt, "junction");
      await fs.rm(previous.keg, { recursive: true });
    }
    for (const command of [daemon, nativeHost]) {
      for (const file of command.programArguments.slice(0, 2)) {
        expect(await fs.readFile(file, "utf8")).toBe("next");
      }
    }
  });

  it("preserves an explicitly selected keg when opt selects another version", async () => {
    const pinned = await install("node@24", "24.1.0", "bin/node");
    const current = await install("node@24", "24.2.0", "bin/node");
    await fs.symlink(current.keg, current.opt, "junction");
    expect(await resolveHomebrewServicePath(pinned.file)).toBe(pinned.file);
    expect(await resolveHomebrewServicePath(current.file)).toBe(path.join(current.opt, "bin/node"));
  });

  it("preserves paths without a usable Homebrew opt link", async () => {
    const node = await install("node", "26.5.0", "bin/node");
    expect(await resolveHomebrewServicePath(node.file)).toBe(node.file);
    await fs.symlink(path.join(prefix, "missing"), node.opt, "junction");
    expect(await resolveHomebrewServicePath(node.file)).toBe(node.file);
    const ordinary = path.join(prefix, "bin", "node");
    expect(await resolveHomebrewServicePath(ordinary)).toBe(ordinary);
    expect(await resolveHomebrewServicePath("C:\\nodejs\\node.exe")).toBe("C:\\nodejs\\node.exe");
  });
});

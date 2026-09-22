import { mkdtempSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRingFileWriter } from "../src/logging/ring-file.js";

const directories: string[] = [];
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "summarize-ring-"));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("ring file writer", () => {
  it("recreates a log directory removed after successful writes", async () => {
    const parent = join(makeTempDir(), "logs");
    const filePath = join(parent, "daemon.jsonl");
    const writer = createRingFileWriter({ filePath, maxBytes: 1024, maxFiles: 2 });
    writer.write("initial");
    await writer.flush();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("initial\n");

    await fs.rm(parent, { recursive: true });
    writer.write("recovered");
    await writer.flush();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("recovered\n");
  });

  it("contains directory failures even when the first write is delayed", async () => {
    const parent = join(makeTempDir(), "logs");
    await fs.writeFile(parent, "not a directory");
    const filePath = join(parent, "daemon.jsonl");
    const writer = createRingFileWriter({ filePath, maxBytes: 1024, maxFiles: 2 });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    writer.write("dropped");
    await writer.flush();
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("retries directory initialization after the path is repaired", async () => {
    const parent = join(makeTempDir(), "logs");
    await fs.writeFile(parent, "not a directory");
    const filePath = join(parent, "daemon.jsonl");
    const writer = createRingFileWriter({ filePath, maxBytes: 1024, maxFiles: 2 });
    writer.write("dropped");
    await writer.flush();
    await fs.rm(parent);
    writer.write("recovered");
    await writer.flush();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("recovered\n");
  });

  it("rotates when size exceeds max bytes", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "daemon.jsonl");
    const writer = createRingFileWriter({ filePath, maxBytes: 40, maxFiles: 2 });

    writer.write("first-line-1234567890");
    writer.write("second-line-1234567890");
    await writer.flush();

    const current = readFileSync(filePath, "utf8");
    const rotated = readFileSync(`${filePath}.1`, "utf8");

    expect(current).toContain("second-line-1234567890");
    expect(rotated).toContain("first-line-1234567890");
  });
});

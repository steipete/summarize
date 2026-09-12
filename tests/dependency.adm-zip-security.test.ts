import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRequire = createRequire(resolve("apps/chrome-extension/package.json"));
const webExtRequire = createRequire(extensionRequire.resolve("web-ext"));
const profileRequire = createRequire(webExtRequire.resolve("firefox-profile"));
const AdmZip = profileRequire("adm-zip");

type Archive = {
  extractEntryTo: (
    entry: string,
    target: string,
    maintainPath: boolean,
    overwrite: boolean,
  ) => void;
  extractAllTo: (target: string, overwrite: boolean) => void;
  extractAllToAsync: (
    target: string,
    overwrite: boolean,
    keepPermissions: boolean,
    callback: (error?: Error) => void,
  ) => void;
};

const modes = ["entry", "directory-entry", "sync", "async"] as const;
async function extract(zip: Archive, target: string, mode: (typeof modes)[number]) {
  if (mode === "entry") zip.extractEntryTo("link/payload.txt", target, true, true);
  else if (mode === "directory-entry") zip.extractEntryTo("link/", target, true, true);
  else if (mode === "sync") zip.extractAllTo(target, true);
  else {
    await new Promise<void>((resolve, reject) => {
      zip.extractAllToAsync(target, true, false, (error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("patched adm-zip dependency", () => {
  it("stops asynchronous extraction after a rejected directory and calls back once", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-zip-security-"));
    try {
      const target = join(root, "target");
      const outside = join(root, "outside");
      await mkdir(target);
      await mkdir(outside);
      await symlink(outside, join(target, "link"), "dir");
      const zip = new AdmZip();
      zip.addFile("link/", Buffer.alloc(0));
      zip.addFile("z-after/", Buffer.alloc(0));
      const calls: Array<Error | undefined> = [];

      zip.extractAllToAsync(target, true, false, (error?: Error) => calls.push(error));

      expect(calls).toHaveLength(1);
      expect(calls[0]).toBeInstanceOf(Error);
      await expect(stat(join(target, "z-after"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const mode of modes) {
    it.each(["directory", "file"])(`rejects a destination %s symlink (${mode})`, async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "summarize-zip-security-"));
      try {
        const target = join(root, "target");
        const outside = join(root, "outside");
        await mkdir(target);
        await mkdir(outside);
        const sentinel = join(outside, "payload.txt");
        await writeFile(sentinel, "untouched");
        if (kind === "directory") await symlink(outside, join(target, "link"), "dir");
        else {
          await mkdir(join(target, "link"));
          await symlink(sentinel, join(target, "link/payload.txt"), "file");
        }
        const zip = new AdmZip();
        zip.addFile("link/", Buffer.alloc(0));
        zip.addFile("link/payload.txt", Buffer.from("overwritten"));

        await expect(extract(zip, target, mode)).rejects.toThrow();
        expect(await readFile(sentinel, "utf8")).toBe("untouched");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it(`allows a caller-selected symlink root (${mode})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "summarize-zip-security-"));
      try {
        const target = join(root, "target");
        const alias = join(root, "alias");
        await mkdir(target);
        await symlink(target, alias, "dir");
        const zip = new AdmZip();
        zip.addFile("link/", Buffer.alloc(0));
        zip.addFile("link/payload.txt", Buffer.from("safe"));

        await extract(zip, alias, mode);
        expect(await readFile(join(target, "link/payload.txt"), "utf8")).toBe("safe");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

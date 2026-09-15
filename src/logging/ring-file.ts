import fs from "node:fs/promises";
import path from "node:path";

export type RingFileOptions = {
  filePath: string;
  maxBytes: number;
  maxFiles: number;
};

export type RingFileWriter = {
  write: (line: string) => void;
  flush: () => Promise<void>;
};

const normalizeMaxFiles = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : 1;

const normalizeMaxBytes = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : 1024;

async function fileSize(pathValue: string): Promise<number> {
  try {
    const stat = await fs.stat(pathValue);
    return stat.size;
  } catch {
    return 0;
  }
}

async function rotateFiles(filePath: string, maxFiles: number) {
  if (maxFiles <= 1) {
    try {
      await fs.truncate(filePath, 0);
    } catch {
      // ignore
    }
    return;
  }

  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dest = `${filePath}.${i}`;
    try {
      await fs.unlink(dest);
    } catch {
      // ignore
    }
    try {
      await fs.rename(src, dest);
    } catch {
      // ignore
    }
  }
}

export function createRingFileWriter(options: RingFileOptions): RingFileWriter {
  const filePath = options.filePath;
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const maxFiles = normalizeMaxFiles(options.maxFiles);
  const dir = path.dirname(filePath);
  let directoryReady = false;
  let chain = Promise.resolve();

  const enqueue = (task: () => Promise<void>) => {
    chain = chain.then(task).catch(() => {});
  };

  const write = (line: string) => {
    const normalized = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = Buffer.byteLength(normalized, "utf8");
    enqueue(async () => {
      if (!directoryReady) {
        await fs.mkdir(dir, { recursive: true });
        directoryReady = true;
      }
      const currentSize = await fileSize(filePath);
      if (currentSize + bytes > maxBytes) {
        await rotateFiles(filePath, maxFiles);
      }
      await fs.appendFile(filePath, normalized, "utf8");
    });
  };

  const flush = async () => await chain;

  return { write, flush };
}

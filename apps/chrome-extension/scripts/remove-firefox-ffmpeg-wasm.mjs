import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await rm(resolve(import.meta.dirname, "..", ".output", "firefox-mv3", "ffmpeg-wasm"), {
  force: true,
  recursive: true,
});

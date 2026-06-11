import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "vendor", "ffmpeg-wasm", "node");
const target = resolve(root, "dist", "ffmpeg-wasm", "node");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

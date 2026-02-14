import { promises as fs } from "node:fs";
import path from "node:path";
import type { SlideImage } from "../slides/types.js";
import { isRichTty, terminalWidth } from "./terminal.js";

export type SlidesRenderMode = "none" | "auto" | "kitty" | "iterm";
export type InlineProtocol = "none" | "kitty" | "iterm";

type RenderSlide = Pick<SlideImage, "imagePath" | "index" | "timestamp">;

function parsePngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24) return null;
  if (
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47 ||
    data[4] !== 0x0d ||
    data[5] !== 0x0a ||
    data[6] !== 0x1a ||
    data[7] !== 0x0a
  ) {
    return null;
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function resolveInlineProtocol({
  mode,
  env,
  stdout,
}: {
  mode: SlidesRenderMode;
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): InlineProtocol {
  if (mode === "none") return "none";
  if (!isRichTty(stdout)) return "none";
  if (mode === "kitty" || mode === "iterm") return mode;

  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();
  if (
    env.KITTY_WINDOW_ID ||
    term.includes("xterm-kitty") ||
    termProgram.includes("ghostty") ||
    termProgram.includes("konsole") ||
    env.KONSOLE_VERSION
  ) {
    return "kitty";
  }
  if (termProgram.includes("iterm") || env.ITERM_SESSION_ID) {
    return "iterm";
  }
  return "none";
}

function clampInt(min: number, max: number, value: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function resolveSlideCellSize({
  width,
  height,
  termCols,
}: {
  width: number | null;
  height: number | null;
  termCols: number;
}): { cols: number; rows: number } {
  const maxCols = clampInt(24, 64, Math.floor(termCols * 0.75));
  const cols = clampInt(16, maxCols, 32);
  if (!width || !height) {
    return { cols, rows: 10 };
  }
  const aspect = height / width;
  const rows = clampInt(4, 24, Math.round(cols * 0.5 * aspect));
  return { cols, rows };
}

function writeKittyImage({
  stdout,
  data,
  cols,
  rows,
  id,
}: {
  stdout: NodeJS.WritableStream;
  data: Buffer;
  cols: number;
  rows: number;
  id: number;
}) {
  const encoded = data.toString("base64");
  const chunkSize = 4096;
  let offset = 0;
  let first = true;
  while (offset < encoded.length) {
    const chunk = encoded.slice(offset, offset + chunkSize);
    offset += chunkSize;
    const more = offset < encoded.length ? 1 : 0;
    if (first) {
      const params = [
        "a=T",
        "f=100",
        `i=${id}`,
        `m=${more}`,
        "q=2",
        `c=${cols}`,
        `r=${rows}`,
        "C=1",
      ].join(",");
      stdout.write(`\u001b_G${params};${chunk}\u001b\\`);
      first = false;
    } else {
      stdout.write(`\u001b_Gm=${more};${chunk}\u001b\\`);
    }
  }
}

function writeItermImage({
  stdout,
  data,
  cols,
  rows,
  name,
}: {
  stdout: NodeJS.WritableStream;
  data: Buffer;
  cols: number;
  rows: number;
  name: string;
}) {
  const encodedName = Buffer.from(name).toString("base64");
  const encodedData = data.toString("base64");
  const args = [
    `name=${encodedName}`,
    `size=${data.length}`,
    "inline=1",
    "preserveAspectRatio=1",
    `width=${cols}`,
    `height=${rows}`,
  ].join(";");
  stdout.write(`\u001b]1337;File=${args}:${encodedData}\u001b\\`);
}

export async function renderSlidesInline({
  slides,
  mode,
  env,
  stdout,
  labelForSlide,
}: {
  slides: RenderSlide[];
  mode: SlidesRenderMode;
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  labelForSlide?: ((slide: RenderSlide) => string) | null;
}): Promise<{ rendered: number; protocol: InlineProtocol }> {
  const renderer = createSlidesInlineRenderer({ mode, env, stdout });
  return renderer.renderSlides({ slides, labelForSlide });
}

export function createSlidesInlineRenderer({
  mode,
  env,
  stdout,
}: {
  mode: SlidesRenderMode;
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): {
  protocol: InlineProtocol;
  renderSlide: (slide: RenderSlide, label?: string | null) => Promise<boolean>;
  renderSlides: (args: {
    slides: RenderSlide[];
    labelForSlide?: ((slide: RenderSlide) => string) | null;
  }) => Promise<{ rendered: number; protocol: InlineProtocol }>;
} {
  const protocol = resolveInlineProtocol({ mode, env, stdout });
  let nextId = 1;

  const renderSlide = async (slide: RenderSlide, label?: string | null) => {
    if (protocol === "none") return false;
    if (label) stdout.write(`${label}\n`);

    let data: Buffer;
    try {
      data = await fs.readFile(slide.imagePath);
    } catch {
      stdout.write("(missing slide image)\n");
      return false;
    }
    if (data.length === 0) {
      stdout.write("(empty slide image)\n");
      return false;
    }
    const termCols = terminalWidth(stdout, env);
    const size = parsePngSize(data);
    const { cols, rows } = resolveSlideCellSize({
      width: size?.width ?? null,
      height: size?.height ?? null,
      termCols,
    });

    if (protocol === "kitty") {
      writeKittyImage({ stdout, data, cols, rows, id: nextId });
      nextId += 1;
    } else if (protocol === "iterm") {
      writeItermImage({
        stdout,
        data,
        cols,
        rows,
        name: path.basename(slide.imagePath) || "slide.png",
      });
    }
    const visualRows = Math.max(1, rows);
    stdout.write("\r\n".repeat(visualRows));
    stdout.write("\r\n");
    return true;
  };

  const renderSlides = async ({
    slides,
    labelForSlide,
  }: {
    slides: RenderSlide[];
    labelForSlide?: ((slide: RenderSlide) => string) | null;
  }) => {
    if (protocol === "none") return { rendered: 0, protocol };
    let rendered = 0;
    for (const slide of slides) {
      const label = labelForSlide?.(slide) ?? null;
      if (await renderSlide(slide, label)) rendered += 1;
    }
    return { rendered, protocol };
  };

  return { protocol, renderSlide, renderSlides };
}

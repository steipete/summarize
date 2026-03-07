import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { renderSlidesInline } from "../src/run/slides-render.js";

const pngData = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
  "base64",
);

function createTtyStream(columns = 120) {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = true;
  (stream as unknown as { columns?: number }).columns = columns;
  return { stream, getText: () => text };
}

function createTtyStreamWithoutColumns() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = true;
  return { stream, getText: () => text };
}

function createNonTtyStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = false;
  return { stream, getText: () => text };
}

async function createTempSlide() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-"));
  const imagePath = path.join(dir, "slide_0001.png");
  await fs.writeFile(imagePath, pngData);
  return imagePath;
}

describe("renderSlidesInline", () => {
  it("returns none when mode is disabled", async () => {
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [
        {
          index: 1,
          timestamp: 0,
          imagePath: "/tmp/missing.png",
        },
      ],
      mode: "none",
      env: {},
      stdout: output.stream,
    });
    expect(result.protocol).toBe("none");
    expect(result.rendered).toBe(0);
    expect(output.getText()).toBe("");
  });

  it("renders kitty images when auto-detected", async () => {
    const imagePath = await createTempSlide();
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 12.3, imagePath }],
      mode: "auto",
      env: { KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" },
      stdout: output.stream,
      labelForSlide: () => "Slide 1",
    });
    expect(result.protocol).toBe("kitty");
    expect(result.rendered).toBe(1);
    expect(output.getText()).toContain("Slide 1");
    expect(output.getText()).toContain("\u001b_G");
    expect(output.getText()).toContain("c=64");
  });

  it("skips rendering when stdout is not a TTY", async () => {
    const imagePath = await createTempSlide();
    const output = createNonTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 12.3, imagePath }],
      mode: "kitty",
      env: { TERM: "xterm-kitty" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("none");
    expect(result.rendered).toBe(0);
    expect(output.getText()).toBe("");
  });

  it("renders kitty images when Konsole is detected", async () => {
    const imagePath = await createTempSlide();
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 1.2, imagePath }],
      mode: "auto",
      env: { TERM_PROGRAM: "konsole" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("kitty");
    expect(result.rendered).toBe(1);
    expect(output.getText()).toContain("\u001b_G");
  });

  it("renders iTerm images when auto-detected", async () => {
    const imagePath = await createTempSlide();
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 4.2, imagePath }],
      mode: "auto",
      env: { TERM_PROGRAM: "iTerm.app" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("iterm");
    expect(result.rendered).toBe(1);
    expect(output.getText()).toContain("\u001b]1337;File=");
    expect(output.getText()).toContain("width=64");
  });

  it("uses COLUMNS when stdout columns are unavailable", async () => {
    const imagePath = await createTempSlide();
    const output = createTtyStreamWithoutColumns();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 9.1, imagePath }],
      mode: "auto",
      env: { TERM: "xterm-kitty", COLUMNS: "90" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("kitty");
    expect(result.rendered).toBe(1);
    expect(output.getText()).toContain("c=54");
  });

  it("caps inline width at double the previous size on wide terminals", async () => {
    const imagePath = await createTempSlide();
    const output = createTtyStream(200);
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 9.1, imagePath }],
      mode: "auto",
      env: { TERM: "xterm-kitty" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("kitty");
    expect(result.rendered).toBe(1);
    expect(output.getText()).toContain("c=64");
  });

  it("renders iTerm images when WezTerm is detected", async () => {
    const imagePath = await createTempSlide();
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 5.1, imagePath }],
      mode: "auto",
      env: { TERM_PROGRAM: "WezTerm" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("iterm");
    expect(result.rendered).toBe(1);
    expect(output.getText()).toContain("\u001b]1337;File=");
  });

  it("does not render inline images for unsupported terminals", async () => {
    const imagePath = await createTempSlide();
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 4.2, imagePath }],
      mode: "auto",
      env: { TERM_PROGRAM: "Terminal.app" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("none");
    expect(result.rendered).toBe(0);
    expect(output.getText()).toBe("");
  });

  it("prints a missing image notice when slides are absent", async () => {
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 0, imagePath: "/tmp/missing-slide.png" }],
      mode: "auto",
      env: { KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("kitty");
    expect(result.rendered).toBe(0);
    expect(output.getText()).toContain("(missing slide image)");
  });

  it("prints an empty image notice when the slide is blank", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-slides-"));
    const imagePath = path.join(dir, "slide_0001.png");
    await fs.writeFile(imagePath, Buffer.alloc(0));
    const output = createTtyStream();
    const result = await renderSlidesInline({
      slides: [{ index: 1, timestamp: 0, imagePath }],
      mode: "auto",
      env: { TERM_PROGRAM: "iTerm.app" },
      stdout: output.stream,
    });
    expect(result.protocol).toBe("iterm");
    expect(result.rendered).toBe(0);
    expect(output.getText()).toContain("(empty slide image)");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

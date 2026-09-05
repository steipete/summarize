import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { captureStream, discardStream } from "./helpers/streams.js";

describe("test output streams", () => {
  it("captures strings and buffers in order without inventing terminal properties", async () => {
    const output = captureStream();
    const finished = once(output.stream, "finish");
    output.stream.write("Hello ");
    output.stream.end(Buffer.from("世界"));
    await finished;
    expect(output.getText()).toBe("Hello 世界");
    expect("isTTY" in output.stream).toBe(false);
    expect("columns" in output.stream).toBe(false);
  });

  it("keeps captures isolated", () => {
    const first = captureStream();
    const second = captureStream();
    first.stream.write("first");
    second.stream.write("second");
    expect(first.getText()).toBe("first");
    expect(second.getText()).toBe("second");
  });

  it("drains discarded output and completes normally", async () => {
    const output = discardStream();
    const finished = once(output, "finish");
    output.write("ignored");
    output.end(Buffer.from("also ignored"));
    await finished;
  });
});

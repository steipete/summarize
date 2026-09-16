import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { prepareExecutionInput } from "../src/application/execution-input.js";
import { createTempFileFromStdin } from "../src/application/stdin-input.js";
import { parseLengthArg, parseRetriesArg, parseYoutubeMode } from "../src/flags.js";
import { CliError, describeCliError } from "../src/locale.js";

describe("localized CLI input validation", () => {
  it.each([
    [
      { input: { kind: "file", filePath: "fixture.txt" }, extractOnly: true },
      "error.extractLocalFiles",
    ],
    [{ input: { kind: "stdin" }, extractOnly: true }, "error.extractStdin"],
    [{ input: { kind: "stdin" }, extractOnly: false }, "error.stdinStreamMissing"],
  ])("retains a descriptor for input validation: %j", async (request, key) => {
    const error = await prepareExecutionInput({
      request: request as never,
      runtime: {} as never,
      emit: () => {},
    }).catch((error) => error);
    expect(error).toBeInstanceOf(CliError);
    expect(error.descriptor().key).toBe(key);
    expect(error.format("tr")).not.toBe(error.message);
    expect(JSON.parse(JSON.stringify(describeCliError(error))).localized.key).toBe(key);
  });

  it("localizes stdin size limits with numeric values", async () => {
    const error = await createTempFileFromStdin({
      stream: Readable.from([Buffer.alloc(1024 * 1024 + 1)]),
      maxBytes: 1024 * 1024,
    }).catch((error) => error);
    expect(error.message).toBe("Stdin content exceeds maximum size of 1.0MB");
    expect(error.format("tr")).toContain("1,0 MB");
    expect(error.descriptor().values.maxMb).toBe(1);
  });

  it.each([
    [() => parseYoutubeMode("fixture-invalid"), "error.unsupportedOption"],
    [() => parseLengthArg("0.001"), "error.optionMinimum"],
    [() => parseRetriesArg("99"), "error.optionRange"],
  ])("localizes invalid flags without changing literal option values", (run, key) => {
    let error: CliError | undefined;
    try {
      run();
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error!.descriptor().key).toBe(key);
    expect(error!.format("tr")).toContain("Desteklenmeyen");
    expect(error!.format("tr")).toContain(error!.descriptor().values.label);
  });
});

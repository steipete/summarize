import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDirectVideoInput } from "@steipete/summarize-core/content/url";
import { CliError } from "../locale.js";
import { MAX_PDF_EXTRACT_BYTES } from "../run/constants.js";
import {
  acquireLocalAssetInput,
  getLocalAssetSize,
  isPdfAssetPath,
  isTranscribableAssetPath,
} from "./input-acquisition.js";
import { createTempFileFromStdin } from "./stdin-input.js";
import type {
  SummarizeEventSink,
  SummarizeInput,
  SummarizeRequest,
  SummarizeRuntime,
} from "./summarize-contracts.js";

type PreparedExecutionInput = {
  input: Exclude<SummarizeInput, { kind: "file" | "stdin" }>;
  cleanup: () => Promise<void>;
};

const noCleanup = async () => {};

function emitAcquiredProgress(
  acquired: Awaited<ReturnType<typeof acquireLocalAssetInput>>,
  extractOnly: boolean,
  emit: SummarizeEventSink,
) {
  emit({
    type: "input-progress",
    phase:
      acquired.kind === "resolved-media"
        ? "transcribing"
        : extractOnly
          ? "extracting"
          : "summarizing",
    source: acquired.sourceLabel,
    filename: acquired.attachment.filename,
    mediaType: acquired.attachment.mediaType,
    sizeBytes: acquired.sizeBytes,
  });
}

export async function prepareExecutionInput({
  request,
  runtime,
  emit,
}: {
  request: SummarizeRequest;
  runtime: SummarizeRuntime;
  emit: SummarizeEventSink;
}): Promise<PreparedExecutionInput> {
  let cleanup = noCleanup;
  try {
    let input: Exclude<SummarizeInput, { kind: "stdin" }>;
    if (request.input.kind === "stdin") {
      if (request.extractOnly) {
        throw new CliError("error.extractStdin");
      }
      if (!runtime.stdin) {
        throw new CliError("error.stdinStreamMissing");
      }
      const temp = await createTempFileFromStdin({ stream: runtime.stdin });
      cleanup = temp.cleanup;
      input = { kind: "file", filePath: temp.filePath };
    } else {
      input = request.input;
    }

    if (input.kind !== "file") return { input, cleanup };
    if (
      request.extractOnly &&
      !isTranscribableAssetPath(input.filePath) &&
      !isPdfAssetPath(input.filePath)
    ) {
      throw new CliError("error.extractLocalFiles");
    }
    if (request.slides && isDirectVideoInput(input.filePath)) {
      return {
        input: {
          kind: "url",
          url: pathToFileURL(input.filePath).href,
          title: null,
          maxCharacters: null,
        },
        cleanup,
      };
    }

    const sizeBytes = await getLocalAssetSize(input.filePath);
    emit({
      type: "input-progress",
      phase: "loading",
      source: input.filePath,
      filename: path.basename(input.filePath),
      mediaType: null,
      sizeBytes,
    });
    const acquired = await acquireLocalAssetInput({
      filePath: input.filePath,
      ...(request.extractOnly && isPdfAssetPath(input.filePath)
        ? { maxBytes: MAX_PDF_EXTRACT_BYTES }
        : {}),
    });
    emitAcquiredProgress(acquired, request.extractOnly, emit);
    return { input: acquired, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

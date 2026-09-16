import { parseSseStream } from "@steipete/summarize-core/runtime";
import { daemonFetch } from "../../lib/daemon-fetch";
import { getDaemonOrigin } from "../../lib/daemon-url";
import {
  message as uiMessage,
  resolveText,
  readLocalizedMessage,
  type LocalizedMessage,
  type LocalizedDescriptor,
  LocalizedError,
} from "../../lib/i18n";
import { parseSseEvent, type SseSlidesData } from "../../lib/runtime-contracts";
import { nextSseMessage } from "../../lib/sse-reader";

export type SlidesStreamController = {
  start: (runId: string) => Promise<void>;
  abort: () => void;
  isStreaming: () => boolean;
};

export type SlidesStreamControllerOptions = {
  getToken: () => Promise<string>;
  onSlides: (slides: SseSlidesData) => void;
  onStatus?: ((text: string, message?: LocalizedMessage) => void) | null;
  onDone?: (() => void) | null;
  onError?: ((error: unknown) => string | LocalizedDescriptor) | null;
  fetchImpl?: typeof fetch;
  idleTimeoutMs?: number;
  idleTimeoutMessage?: string | LocalizedDescriptor;
};

export function createSlidesStreamController(
  options: SlidesStreamControllerOptions,
): SlidesStreamController {
  const {
    getToken,
    onSlides,
    onStatus,
    onDone,
    onError,
    fetchImpl,
    idleTimeoutMs = 300_000,
    idleTimeoutMessage = uiMessage("error.slidesTimeout"),
  } = options;
  let controller: AbortController | null = null;
  let streaming = false;
  let activeAbortState: { reason: "manual" | "timeout" | null } | null = null;
  let activeGeneration = 0;

  const abort = () => {
    activeGeneration += 1;
    if (!controller) {
      activeAbortState = null;
      streaming = false;
      return;
    }
    if (activeAbortState) activeAbortState.reason = "manual";
    controller.abort();
    controller = null;
    activeAbortState = null;
    streaming = false;
  };

  const start = async (runId: string) => {
    const generation = activeGeneration + 1;
    activeGeneration = generation;
    if (controller) {
      if (activeAbortState) activeAbortState.reason = "manual";
      controller.abort();
      controller = null;
      activeAbortState = null;
    }
    streaming = true;
    const token = (await getToken()).trim();
    if (generation !== activeGeneration) return;
    if (!token) {
      streaming = false;
      return;
    }
    const nextController = new AbortController();
    controller = nextController;
    const abortState = { reason: null as "manual" | "timeout" | null };
    activeAbortState = abortState;
    let sawDone = false;

    try {
      const origin = await getDaemonOrigin();
      const res = await (fetchImpl ?? daemonFetch)(
        `${origin}/v1/summarize/${runId}/slides/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: nextController.signal,
        },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (!res.body) throw new LocalizedError(uiMessage("error.streamBody"));

      const iterator = parseSseStream(res.body);
      while (true) {
        const { value: msg, done } = await nextSseMessage(
          iterator,
          idleTimeoutMs,
          resolveText(idleTimeoutMessage),
        );
        if (done) break;
        if (generation !== activeGeneration) return;
        if (nextController.signal.aborted) return;
        const event = parseSseEvent(msg);
        if (!event) continue;
        if (event.event === "slides") {
          onSlides(event.data);
        } else if (event.event === "status") {
          const localized = readLocalizedMessage(event.data.message);
          if (localized) onStatus?.(event.data.text ?? "", localized);
          else onStatus?.(event.data.text ?? "");
        } else if (event.event === "error") {
          const localized = readLocalizedMessage(event.data.localized);
          if (localized) throw new LocalizedError(localized);
          throw new Error(event.data.message);
        } else if (event.event === "done") {
          sawDone = true;
          break;
        }
      }

      if (generation !== activeGeneration) return;
      if (nextController.signal.aborted) return;
      if (!sawDone) {
        throw new LocalizedError(uiMessage("error.streamEnded"));
      }
    } catch (err) {
      if (err instanceof Error && err.name === "IdleTimeoutError") {
        abortState.reason = "timeout";
        if (!nextController.signal.aborted) {
          nextController.abort();
        }
      }
      if (nextController.signal.aborted && abortState.reason !== "timeout") return;
      const failure =
        abortState.reason === "timeout" && typeof idleTimeoutMessage !== "string"
          ? new LocalizedError(idleTimeoutMessage)
          : err;
      onError?.(failure);
    } finally {
      if (generation === activeGeneration && controller === nextController) {
        streaming = false;
        activeAbortState = null;
        if (!nextController.signal.aborted) {
          onDone?.();
        }
      }
    }
  };

  return {
    start,
    abort,
    isStreaming: () => streaming,
  };
}

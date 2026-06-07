import type { SseSlidesData } from "../../lib/runtime-contracts";
import { normalizeSlidesPayload } from "./slides-payload";
import {
  createSlidesStreamController,
  type SlidesStreamController,
} from "./slides-stream-controller";

export type SlidesHydrator = {
  start: (runId: string, opts?: { silent?: boolean; local?: boolean }) => Promise<void>;
  stop: () => void;
  isStreaming: () => boolean;
  getActiveRunId: () => string | null;
  handlePayload: (payload: SseSlidesData) => void;
  handleSummaryFromCache: (value: boolean | null | undefined) => void;
  syncFromCache: (args: {
    runId: string | null;
    summaryFromCache: boolean | null | undefined;
    hasSlides: boolean;
  }) => void;
  hydrateSnapshot: (reason?: string) => Promise<void>;
};

export type SlidesHydratorOptions = {
  getToken: () => Promise<string>;
  onSlides: (slides: SseSlidesData) => void;
  onStatus?: ((text: string) => void) | null;
  onDone?: (() => void) | null;
  onError?: ((error: unknown) => string) | null;
  onSnapshotError?: ((error: unknown) => void) | null;
  resolveLocalSlides?: ((runId: string) => Promise<SseSlidesData | null>) | null;
  streamFetchImpl?: typeof fetch;
  snapshotFetchImpl?: typeof fetch;
};

type SnapshotResponse = { ok?: boolean; slides?: SseSlidesData };

export function createSlidesHydrator(options: SlidesHydratorOptions): SlidesHydrator {
  const {
    getToken,
    onSlides,
    onStatus,
    onDone,
    onError,
    onSnapshotError,
    resolveLocalSlides,
    streamFetchImpl,
    snapshotFetchImpl,
  } = options;

  let activeRunId: string | null = null;
  let hasSlidesPayload = false;
  let snapshotRequestId = 0;
  let snapshotInFlight = false;
  let activeStartRequestId = 0;
  let suppressStreamErrors = false;

  const setActiveRunId = (runId: string | null) => {
    activeRunId = runId;
    hasSlidesPayload = false;
    snapshotInFlight = false;
    snapshotRequestId += 1;
  };

  const handlePayload = (payload: SseSlidesData) => {
    if (!activeRunId) return;
    const normalized = normalizeSlidesPayload(payload);
    if (!normalized) return;
    hasSlidesPayload = true;
    onSlides(normalized);
  };

  const hydrateSnapshot = async (_reason?: string) => {
    if (!activeRunId) return;
    if (snapshotInFlight) return;
    const runId = activeRunId;
    const requestId = ++snapshotRequestId;
    snapshotInFlight = true;
    try {
      const localSlides = (await resolveLocalSlides?.(runId)) ?? null;
      if (localSlides && activeRunId === runId && snapshotRequestId === requestId) {
        handlePayload(localSlides);
        return;
      }
      const token = (await getToken()).trim();
      if (!token) return;
      const res = await (snapshotFetchImpl ?? fetch)(
        `http://127.0.0.1:8787/v1/summarize/${runId}/slides`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return;
      const json = (await res.json()) as SnapshotResponse;
      if (!json?.ok || !json.slides) return;
      if (activeRunId !== runId || snapshotRequestId !== requestId) return;
      handlePayload(json.slides);
    } catch (error) {
      onSnapshotError?.(error);
    } finally {
      if (snapshotRequestId === requestId) {
        snapshotInFlight = false;
      }
    }
  };

  const stream: SlidesStreamController = createSlidesStreamController({
    getToken,
    onSlides: handlePayload,
    onStatus,
    onError: (error) => {
      if (suppressStreamErrors) return "";
      return onError?.(error) ?? "";
    },
    onDone: () => {
      if (!hasSlidesPayload) {
        void hydrateSnapshot("stream-done");
      }
      onDone?.();
    },
    fetchImpl: streamFetchImpl,
  });

  const start = async (runId: string, opts?: { silent?: boolean; local?: boolean }) => {
    const requestId = activeStartRequestId + 1;
    activeStartRequestId = requestId;
    setActiveRunId(runId);
    suppressStreamErrors = Boolean(opts?.silent);
    try {
      const localSlides = (await resolveLocalSlides?.(runId)) ?? null;
      if (activeStartRequestId !== requestId) return;
      if (localSlides && activeStartRequestId === requestId) {
        handlePayload(localSlides);
        onDone?.();
        return;
      }
      if (opts?.local) {
        onDone?.();
        return;
      }
      await stream.start(runId);
    } finally {
      if (activeStartRequestId === requestId) {
        suppressStreamErrors = false;
      }
    }
  };

  const stop = () => {
    activeStartRequestId += 1;
    suppressStreamErrors = false;
    setActiveRunId(null);
    stream.abort();
  };

  const handleSummaryFromCache = (value: boolean | null | undefined) => {
    if (value == null) return;
    if (value) {
      void hydrateSnapshot("summary-cache");
    }
  };

  const syncFromCache = ({
    runId,
    summaryFromCache,
    hasSlides,
  }: {
    runId: string | null;
    summaryFromCache: boolean | null | undefined;
    hasSlides: boolean;
  }) => {
    if (!runId) return;
    if (activeRunId !== runId) {
      setActiveRunId(runId);
    }
    if (hasSlides) {
      hasSlidesPayload = true;
      return;
    }
    if (!stream.isStreaming()) {
      void start(runId, { silent: true });
    }
    if (summaryFromCache) {
      void hydrateSnapshot("summary-cache");
    }
  };

  return {
    start,
    stop,
    isStreaming: () => stream.isStreaming(),
    getActiveRunId: () => activeRunId,
    handlePayload,
    handleSummaryFromCache,
    syncFromCache,
    hydrateSnapshot,
  };
}

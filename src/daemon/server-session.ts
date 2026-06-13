import { type SseEvent, type SseSlidesData } from "@steipete/summarize-core/runtime";
import type { SlideExtractionResult } from "../slides/index.js";
import {
  closeBufferedSseChannel,
  createBufferedSseChannel,
  pushBufferedSseEvent,
  type BufferedSseChannel,
} from "./server-event-channel.js";

export type SessionEvent = SseEvent;

export type Session = {
  id: string;
  createdAtMs: number;
  summaryEvents: BufferedSseChannel;
  slideEvents: BufferedSseChannel;
  slidesRequested: boolean;
  slidesLastStatus: string | null;
  lastMeta: {
    model: string | null;
    modelLabel: string | null;
    inputSummary: string | null;
    summaryFromCache: boolean | null;
  };
  transcriptTimedText: string | null;
  slides: SlideExtractionResult | null;
};

const SESSION_TTL_MS = 15 * 60 * 1000;

export function createSession(idFactory: () => string): Session {
  return {
    id: idFactory(),
    createdAtMs: Date.now(),
    summaryEvents: createBufferedSseChannel(),
    slideEvents: createBufferedSseChannel(),
    slidesRequested: false,
    slidesLastStatus: null,
    lastMeta: {
      model: null,
      modelLabel: null,
      inputSummary: null,
      summaryFromCache: null,
    },
    transcriptTimedText: null,
    slides: null,
  };
}

export function pushToSession(
  session: Session,
  event: SessionEvent,
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null,
) {
  if (session.summaryEvents.done) return;
  pushBufferedSseEvent(session.summaryEvents, event);
  onSessionEvent?.(event, session.id);
  if (event.event === "done" || event.event === "error") {
    session.summaryEvents.done = true;
    closeBufferedSseChannel(session.summaryEvents);
  }
}

export function pushSlidesToSession(
  session: Session,
  event: SessionEvent,
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null,
) {
  pushBufferedSseEvent(session.slideEvents, event);
  onSessionEvent?.(event, session.id);
  if (event.event === "done") {
    session.slideEvents.done = true;
    closeBufferedSseChannel(session.slideEvents);
  }
  if (event.event === "status") session.slidesLastStatus = event.data.text;
}

export function emitMeta(
  session: Session,
  data: {
    model?: string | null;
    modelLabel?: string | null;
    inputSummary?: string | null;
    summaryFromCache?: boolean | null;
  },
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null,
) {
  session.lastMeta = {
    model: typeof data.model === "string" ? data.model : session.lastMeta.model,
    modelLabel: typeof data.modelLabel === "string" ? data.modelLabel : session.lastMeta.modelLabel,
    inputSummary:
      typeof data.inputSummary === "string" ? data.inputSummary : session.lastMeta.inputSummary,
    summaryFromCache:
      typeof data.summaryFromCache === "boolean"
        ? data.summaryFromCache
        : session.lastMeta.summaryFromCache,
  };
  pushToSession(session, { event: "meta", data: session.lastMeta }, onSessionEvent);
}

export function emitSlides(
  session: Session,
  data: SseSlidesData,
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null,
) {
  pushToSession(session, { event: "slides", data }, onSessionEvent);
  pushSlidesToSession(session, { event: "slides", data }, onSessionEvent);
}

export function emitSlidesStatus(
  session: Session,
  text: string,
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null,
) {
  const trimmed = text.trim();
  if (!trimmed) return;
  pushSlidesToSession(session, { event: "status", data: { text: trimmed } }, onSessionEvent);
}

export function emitSlidesDone(
  session: Session,
  result: { ok: boolean; error?: string | null },
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null,
) {
  if (!result.ok) {
    const message = result.error?.trim() || "Slides failed.";
    pushSlidesToSession(session, { event: "error", data: { message } }, onSessionEvent);
  }
  pushSlidesToSession(session, { event: "done", data: {} }, onSessionEvent);
}

export function endSession(session: Session) {
  closeBufferedSseChannel(session.summaryEvents);
  closeBufferedSseChannel(session.slideEvents);
}

export function scheduleSessionCleanup({
  sessions,
  refreshSessions,
  session,
}: {
  sessions: Map<string, Session>;
  refreshSessions: Map<string, Session>;
  session: Session;
}) {
  setTimeout(() => {
    sessions.delete(session.id);
    refreshSessions.delete(session.id);
    endSession(session);
  }, SESSION_TTL_MS).unref();
}

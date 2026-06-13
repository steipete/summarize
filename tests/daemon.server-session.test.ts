import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createSession,
  emitSlidesDone,
  emitSlidesStatus,
  endSession,
  pushToSession,
} from "../src/daemon/server-session.js";

function createClient() {
  const client = {
    write: vi.fn(),
    end: vi.fn(),
  };
  return client as unknown as http.ServerResponse & typeof client;
}

describe("daemon server sessions", () => {
  it("buffers and broadcasts summary events until the channel terminates", () => {
    const session = createSession(() => "summary-1");
    const client = createClient();
    const onEvent = vi.fn();
    session.summaryEvents.clients.add(client);

    pushToSession(session, { event: "status", data: { text: "working" } }, onEvent);
    pushToSession(session, { event: "done", data: {} }, onEvent);
    pushToSession(session, { event: "status", data: { text: "ignored" } }, onEvent);

    expect(session.summaryEvents.buffer.map((entry) => entry.event.event)).toEqual([
      "status",
      "done",
    ]);
    expect(session.summaryEvents.done).toBe(true);
    expect(client.write).toHaveBeenCalledTimes(2);
    expect(client.end).toHaveBeenCalledOnce();
    expect(session.summaryEvents.clients.size).toBe(0);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("keeps slide terminal sequencing separate from summary policy", () => {
    const session = createSession(() => "summary-1");
    const client = createClient();
    const onEvent = vi.fn();
    session.slideEvents.clients.add(client);

    emitSlidesStatus(session, "  extracting  ", onEvent);
    emitSlidesDone(session, { ok: false, error: "failed" }, onEvent);

    expect(session.slideEvents.buffer.map((entry) => entry.event.event)).toEqual([
      "status",
      "error",
      "done",
    ]);
    expect(session.slideEvents.done).toBe(true);
    expect(client.write).toHaveBeenCalledTimes(3);
    expect(client.end).toHaveBeenCalledOnce();
    expect(session.slideEvents.clients.size).toBe(0);
    expect(session.slidesLastStatus).toBe("extracting");
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it("bounds each event buffer by encoded byte size", () => {
    const session = createSession(() => "summary-1");
    const text = "x".repeat(600_000);

    pushToSession(session, { event: "chunk", data: { text } });
    pushToSession(session, { event: "chunk", data: { text } });

    expect(session.summaryEvents.buffer).toHaveLength(1);
    expect(session.summaryEvents.bufferBytes).toBeLessThanOrEqual(1_000_000);
  });

  it("ends and detaches clients from both channels", () => {
    const session = createSession(() => "summary-1");
    const summaryClient = createClient();
    const slideClient = createClient();
    session.summaryEvents.clients.add(summaryClient);
    session.slideEvents.clients.add(slideClient);

    endSession(session);

    expect(summaryClient.end).toHaveBeenCalledOnce();
    expect(slideClient.end).toHaveBeenCalledOnce();
    expect(session.summaryEvents.clients.size).toBe(0);
    expect(session.slideEvents.clients.size).toBe(0);
  });
});

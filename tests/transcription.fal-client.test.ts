import { describe, expect, it, vi } from "vitest";
import { createFalClient } from "../packages/core/src/transcription/whisper/fal-client.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FAL REST client", () => {
  it("uploads media and retrieves a queued transcription", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/storage/upload/initiate")) {
        expect(init?.headers).toMatchObject({ Authorization: "Key FAL" });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          content_type: "audio/mpeg",
          file_name: "audio.mpeg",
        });
        return jsonResponse({
          upload_url: "https://upload.example/audio",
          file_url: "https://v3.fal.media/files/audio",
        });
      }
      if (url === "https://upload.example/audio") {
        expect(init?.method).toBe("PUT");
        expect(init?.body).toBeInstanceOf(Blob);
        return new Response(null, { status: 200 });
      }
      if (url === "https://queue.fal.run/fal-ai/wizper") {
        expect(init?.headers).toMatchObject({
          Authorization: "Key FAL",
          "X-Fal-Queue-Priority": "normal",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          audio_url: "https://v3.fal.media/files/audio",
          language: "en",
        });
        return jsonResponse({
          request_id: "request-1",
          status_url: "https://queue.fal.run/fal-ai/wizper/requests/request-1/status",
          response_url: "https://queue.fal.run/fal-ai/wizper/requests/request-1",
        });
      }
      if (url.endsWith("/requests/request-1/status")) {
        return jsonResponse({ status: "COMPLETED" });
      }
      if (url.endsWith("/requests/request-1")) {
        return jsonResponse({ text: "hello world" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });
    const audioUrl = await fal.storage.upload(new Blob(["audio"], { type: "audio/mpeg" }));
    const result = await fal.subscribe("fal-ai/wizper", {
      input: { audio_url: audioUrl, language: "en" },
    });

    expect(result).toEqual({ data: { text: "hello world" }, requestId: "request-1" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("ignores queue URLs returned by the submission endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://queue.fal.run/fal-ai/wizper") {
        return jsonResponse({
          request_id: "request-1",
          status_url: "https://evil.example/status",
          response_url: "https://evil.example/result",
        });
      }
      if (url.endsWith("/requests/request-1/status")) {
        return jsonResponse({ status: "COMPLETED" });
      }
      if (url.endsWith("/requests/request-1")) return jsonResponse({ text: "safe" });
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });
    await expect(
      fal.subscribe("fal-ai/wizper", {
        input: { audio_url: "https://example.com/audio", language: "en" },
      }),
    ).resolves.toEqual({ data: { text: "safe" }, requestId: "request-1" });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "https://evil.example/status",
    );
  });

  it("uses safe upload defaults and reports upload failures", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/storage/upload/initiate")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          content_type: "application/octet-stream",
          file_name: "audio.bin",
        });
        return jsonResponse({
          upload_url: "https://upload.example/audio",
          file_url: "https://v3.fal.media/files/audio",
        });
      }
      if (url === "https://upload.example/audio") {
        expect(init?.headers).toEqual({ "Content-Type": "application/octet-stream" });
        return new Response(null, { status: 403, statusText: "Forbidden" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });
    await expect(fal.storage.upload(new Blob(["audio"]))).rejects.toThrow(
      "FAL upload failed (403 Forbidden)",
    );
  });

  it("uses multipart uploads for media above 90 MB", async () => {
    const uploadedParts: number[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/storage/upload/initiate-multipart")) {
        return jsonResponse({
          upload_url: "https://upload.example/multipart?token=test",
          file_url: "https://v3.fal.media/files/large-audio",
        });
      }
      const partMatch = url.match(/\/multipart\/(\d+)\?token=test$/);
      if (partMatch) {
        const partNumber = Number(partMatch[1]);
        uploadedParts.push(partNumber);
        expect(init?.method).toBe("PUT");
        return jsonResponse({ partNumber, etag: `etag-${partNumber}` });
      }
      if (url === "https://upload.example/multipart/complete?token=test") {
        const body = JSON.parse(String(init?.body)) as {
          parts: Array<{ partNumber: number; etag: string }>;
        };
        expect(body.parts).toHaveLength(10);
        expect(body.parts.at(-1)).toEqual({ partNumber: 10, etag: "etag-10" });
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const file = new Blob(["audio"], { type: "audio/mpeg" });
    Object.defineProperty(file, "size", { value: 90 * 1024 * 1024 + 1 });
    const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });

    await expect(fal.storage.upload(file)).resolves.toBe("https://v3.fal.media/files/large-audio");
    expect(uploadedParts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("retries transient FAL responses", async () => {
    vi.useFakeTimers();
    let submissions = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://queue.fal.run/fal-ai/wizper") {
        submissions += 1;
        return submissions === 1
          ? jsonResponse({ detail: "try again" }, 503)
          : jsonResponse({ request_id: "request-retry" });
      }
      if (url.endsWith("/requests/request-retry/status")) {
        return jsonResponse({ status: "COMPLETED" });
      }
      if (url.endsWith("/requests/request-retry")) {
        return jsonResponse({ text: "retried" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });
      const pending = fal.subscribe("fal-ai/wizper", { input: {} });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({
        data: { text: "retried" },
        requestId: "request-retry",
      });
      expect(submissions).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries network failures and polls queued requests", async () => {
    vi.useFakeTimers();
    let submissions = 0;
    let statusChecks = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://queue.fal.run/fal-ai/wizper") {
        submissions += 1;
        if (submissions === 1) throw new TypeError("fetch failed");
        return jsonResponse({ request_id: "request-queued" });
      }
      if (url.endsWith("/requests/request-queued/status")) {
        statusChecks += 1;
        return jsonResponse({ status: statusChecks === 1 ? "IN_QUEUE" : "COMPLETED" });
      }
      if (url.endsWith("/requests/request-queued")) {
        return jsonResponse({ text: "queued" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });
      const pending = fal.subscribe("fal-ai/wizper", { input: {} });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({
        data: { text: "queued" },
        requestId: "request-queued",
      });
      expect(submissions).toBe(2);
      expect(statusChecks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling when the subscription is aborted", async () => {
    vi.useFakeTimers();
    let statusChecks = 0;
    const controller = new AbortController();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.signal).toBe(controller.signal);
      if (url === "https://queue.fal.run/fal-ai/wizper") {
        return jsonResponse({ request_id: "request-abort" });
      }
      if (url.endsWith("/requests/request-abort/status")) {
        statusChecks += 1;
        return jsonResponse({ status: "IN_PROGRESS" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });
      const pending = fal.subscribe("fal-ai/wizper", {
        input: {},
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(statusChecks).toBe(1);

      const abortError = new Error("subscription cancelled");
      controller.abort(abortError);
      await expect(pending).rejects.toBe(abortError);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(statusChecks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry after aborting during backoff", async () => {
    vi.useFakeTimers();
    let submissions = 0;
    const controller = new AbortController();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://queue.fal.run/fal-ai/wizper") {
        submissions += 1;
        return jsonResponse({ detail: "try again" }, 503);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const fal = createFalClient({ credentials: "FAL", fetchImpl: fetchMock });
      const pending = fal.subscribe("fal-ai/wizper", {
        input: {},
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(submissions).toBe(1);

      const abortError = new Error("subscription cancelled");
      controller.abort(abortError);
      await expect(pending).rejects.toBe(abortError);
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(submissions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports malformed and failed queue responses", async () => {
    const missingRequestId = createFalClient({
      credentials: "FAL",
      fetchImpl: vi.fn(async () => jsonResponse({})) as typeof fetch,
    });
    await expect(missingRequestId.subscribe("fal-ai/wizper", { input: {} })).rejects.toThrow(
      "no request ID",
    );

    const failedRequest = createFalClient({
      credentials: "FAL",
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://queue.fal.run/fal-ai/wizper") {
          return jsonResponse({ request_id: "request-2" });
        }
        if (url.endsWith("/requests/request-2/status")) {
          return jsonResponse({ status: "COMPLETED", error: { message: "transcription failed" } });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    });
    await expect(failedRequest.subscribe("fal-ai/wizper", { input: {} })).rejects.toThrow(
      "transcription failed",
    );

    const invalidStatus = createFalClient({
      credentials: "FAL",
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://queue.fal.run/fal-ai/wizper") {
          return jsonResponse({ request_id: "request-3" });
        }
        if (url.endsWith("/requests/request-3/status")) {
          return jsonResponse({ status: "FAILED" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as typeof fetch,
    });
    await expect(invalidStatus.subscribe("fal-ai/wizper", { input: {} })).rejects.toThrow(
      "unknown queue status: FAILED",
    );
  });

  it("includes JSON error details from FAL", async () => {
    const fal = createFalClient({
      credentials: "FAL",
      fetchImpl: vi.fn(async () =>
        jsonResponse({ detail: { message: "invalid request" } }, 400),
      ) as typeof fetch,
    });

    await expect(fal.subscribe("fal-ai/wizper", { input: {} })).rejects.toThrow(
      "FAL request failed (400): invalid request",
    );
  });
});

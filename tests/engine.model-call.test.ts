import { describe, expect, it, vi } from "vitest";
import { resolveModelIdForLlmCall } from "../src/engine/model-call.js";
import { parseGatewayStyleModelId } from "../src/llm/model-id.js";

describe("model call resolution", () => {
  it("skips Developer API model discovery for a custom Google base URL", async () => {
    const fetchMock = vi.fn();

    const result = await resolveModelIdForLlmCall({
      parsedModel: parseGatewayStyleModelId("google/gemini-custom-preview"),
      apiKeys: { googleApiKey: "test" },
      googleBaseUrlOverride: "https://google-proxy.example.com",
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 2000,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      modelId: "google/gemini-custom-preview",
      note: null,
      forceStreamOff: false,
    });
  });

  it.each([
    ["an unset base URL", undefined],
    ["the explicit Developer API base URL", "https://generativelanguage.googleapis.com/v1beta"],
    [
      "the explicit Developer API base URL with a trailing slash",
      "https://generativelanguage.googleapis.com/v1beta/",
    ],
  ])("keeps Developer API model discovery for %s", async (_description, googleBaseUrlOverride) => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [{ name: "models/gemini-custom" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await resolveModelIdForLlmCall({
      parsedModel: parseGatewayStyleModelId("google/gemini-custom-preview"),
      apiKeys: { googleApiKey: "test" },
      googleBaseUrlOverride,
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 2000,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.modelId).toBe("google/gemini-custom");
  });
});

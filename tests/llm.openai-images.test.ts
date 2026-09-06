import { describe, expect, it, vi } from "vitest";
import { promptToContext } from "../src/llm/generate-text-shared.js";
import { completeOpenAiText, streamOpenAiText } from "../src/llm/providers/openai.js";

describe("OpenAI image requests", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("preserves image content (chat=%s, stream=%s)", async (chat, stream) => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const imageUrl = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    const fetchImpl = vi.fn(async () => {
      const payload = stream
        ? chat
          ? 'data: {"choices":[{"delta":{"content":"Blue triangle"}}]}\n\ndata: [DONE]\n\n'
          : 'data: {"type":"response.output_text.delta","delta":"Blue triangle"}\n\ndata: {"type":"response.completed","response":{}}\n\n'
        : JSON.stringify(
            chat
              ? { choices: [{ message: { content: "Blue triangle" } }] }
              : { output_text: "Blue triangle" },
          );
      return new Response(payload, {
        headers: { "content-type": stream ? "text/event-stream" : "application/json" },
      });
    });
    const request = {
      modelId: "gpt-5-mini",
      openaiConfig: {
        apiKey: "test-key",
        isOpenRouter: false,
        useChatCompletions: chat,
        requestOptions: {},
      },
      context: promptToContext({
        system: "Describe the image.",
        userText: "What is visible?",
        attachments: [{ kind: "image", bytes, mediaType: "image/png" }],
      }),
      signal: new AbortController().signal,
      fetchImpl,
    };
    if (stream) {
      const result = await streamOpenAiText(request);
      let text = "";
      for await (const chunk of result.textStream) text += chunk;
      expect(text).toBe("Blue triangle");
    } else {
      expect((await completeOpenAiText(request)).text).toBe("Blue triangle");
    }
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toContain(chat ? "/chat/completions" : "/responses");
    expect(chat ? body.messages[1].content : body.input[0].content).toEqual(
      chat
        ? [
            { type: "text", text: "What is visible?" },
            { type: "image_url", image_url: { url: imageUrl } },
          ]
        : [
            { type: "input_text", text: "What is visible?" },
            { type: "input_image", image_url: imageUrl, detail: "auto" },
          ],
    );
  });
});

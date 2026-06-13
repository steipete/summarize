import { describe, expect, it } from "vitest";
import { generateTextWithModelId } from "../../src/llm/generate-text.js";
import { buildDocumentPrompt } from "../helpers/document-prompt.js";
import { buildMinimalPdf } from "../helpers/pdf.js";

const LIVE = process.env.SUMMARIZE_LIVE_TEST === "1";

function shouldSoftSkipLiveError(message: string): boolean {
  return /(model.*not found|does not exist|permission|access|unauthorized|forbidden|404|not_found|model_not_found|unsupported|invalid_request)/i.test(
    message,
  );
}

(LIVE ? describe : describe.skip)("live openai PDF", () => {
  const timeoutMs = 120_000;
  const openaiApiKey = process.env.OPENAI_API_KEY ?? null;

  it(
    "summarizes PDF attachments",
    async ({ skip }) => {
      if (!openaiApiKey) {
        skip("requires OPENAI_API_KEY");
      }

      try {
        const pdfBytes = buildMinimalPdf("Hello PDF");
        const result = await generateTextWithModelId({
          modelId: "openai/gpt-5.2",
          apiKeys: {
            xaiApiKey: null,
            openaiApiKey,
            googleApiKey: null,
            anthropicApiKey: null,
            openrouterApiKey: null,
          },
          prompt: buildDocumentPrompt({
            text: "Summarize the attached PDF in one sentence.",
            bytes: pdfBytes,
            filename: "hello.pdf",
          }),
          maxOutputTokens: 256,
          timeoutMs,
          fetchImpl: globalThis.fetch.bind(globalThis),
        });
        expect(result.text.trim().length).toBeGreaterThan(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (shouldSoftSkipLiveError(message)) return;
        throw error;
      }
    },
    timeoutMs,
  );
});

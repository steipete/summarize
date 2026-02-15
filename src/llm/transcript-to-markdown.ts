import type { OutputLanguage } from "../language.js";
import type { LlmTokenUsage } from "./generate-text.js";
import { formatOutputLanguageInstruction } from "../language.js";
import { generateTextWithModelId } from "./generate-text.js";

const MAX_TRANSCRIPT_INPUT_CHARACTERS = 200_000;

function buildTranscriptToMarkdownPrompt({
  title,
  source,
  transcript,
  outputLanguage,
}: {
  title: string | null;
  source: string | null;
  transcript: string;
  outputLanguage?: OutputLanguage | null;
}): { system: string; prompt: string } {
  const languageInstruction = formatOutputLanguageInstruction(outputLanguage ?? { kind: "auto" });

  const system = `You convert raw transcripts into clean GitHub-Flavored Markdown.

Rules:
- Add paragraph breaks at natural topic transitions
- Add headings (##) for major topic changes
- Format lists, quotes, and emphasis where appropriate
- Light cleanup: remove filler words (um, uh, you know) and false starts
- Do not invent content or change meaning
- Preserve technical terms, names, and quotes accurately
- ${languageInstruction}
- Output ONLY Markdown (no JSON, no explanations, no code fences wrapping the output)`;

  const prompt = `Title: ${title ?? "unknown"}
Source: ${source ?? "unknown"}

Transcript:
"""
${transcript}
"""`;

  return { system, prompt };
}

export type ConvertTranscriptToMarkdown = (args: {
  title: string | null;
  source: string | null;
  transcript: string;
  timeoutMs: number;
  outputLanguage?: OutputLanguage | null;
}) => Promise<string>;

export function createTranscriptToMarkdownConverter({
  modelId,
  forceOpenRouter,
  xaiApiKey,
  googleApiKey,
  openaiApiKey,
  openaiBaseUrlOverride,
  anthropicBaseUrlOverride,
  googleBaseUrlOverride,
  xaiBaseUrlOverride,
  anthropicApiKey,
  openrouterApiKey,
  fetchImpl,
  forceChatCompletions,
  retries = 0,
  onRetry,
  onUsage,
}: {
  modelId: string;
  forceOpenRouter?: boolean;
  xaiApiKey: string | null;
  googleApiKey: string | null;
  openaiApiKey: string | null;
  openaiBaseUrlOverride?: string | null;
  anthropicBaseUrlOverride?: string | null;
  googleBaseUrlOverride?: string | null;
  xaiBaseUrlOverride?: string | null;
  fetchImpl: typeof fetch;
  anthropicApiKey: string | null;
  openrouterApiKey: string | null;
  forceChatCompletions?: boolean;
  retries?: number;
  onRetry?: (notice: {
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: unknown;
  }) => void;
  onUsage?: (usage: {
    model: string;
    provider: "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia" | "vertex";
    usage: LlmTokenUsage | null;
  }) => void;
}): ConvertTranscriptToMarkdown {
  return async ({ title, source, transcript, timeoutMs, outputLanguage }) => {
    const trimmedTranscript =
      transcript.length > MAX_TRANSCRIPT_INPUT_CHARACTERS
        ? transcript.slice(0, MAX_TRANSCRIPT_INPUT_CHARACTERS)
        : transcript;
    const { system, prompt } = buildTranscriptToMarkdownPrompt({
      title,
      source,
      transcript: trimmedTranscript,
      outputLanguage,
    });

    const result = await generateTextWithModelId({
      modelId,
      apiKeys: { xaiApiKey, googleApiKey, openaiApiKey, anthropicApiKey, openrouterApiKey },
      forceOpenRouter,
      openaiBaseUrlOverride,
      anthropicBaseUrlOverride,
      googleBaseUrlOverride,
      xaiBaseUrlOverride,
      forceChatCompletions,
      prompt: { system, userText: prompt },
      timeoutMs,
      fetchImpl,
      retries,
      onRetry,
    });
    onUsage?.({
      model: result.canonicalModelId,
      provider: result.provider,
      usage: result.usage ?? null,
    });
    return result.text;
  };
}

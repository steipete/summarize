import type { ConvertHtmlToMarkdown } from "@steipete/summarize-core/content";
import { formatOutputLanguageInstruction, type OutputLanguage } from "../language.js";
import { generateTextWithModelId, type LlmTokenUsage } from "./generate-text.js";
import type { LlmProvider } from "./model-id.js";

const MAX_MARKDOWN_INPUT_CHARACTERS = 200_000;

function buildHtmlToMarkdownPrompt({
  url,
  title,
  siteName,
  html,
}: {
  url: string;
  title: string | null;
  siteName: string | null;
  html: string;
}): { system: string; prompt: string } {
  const system = `You convert HTML into clean GitHub-Flavored Markdown.

Rules:
- Output ONLY Markdown (no JSON, no explanations, no code fences).
- Keep headings, lists, code blocks, blockquotes.
- Preserve links as Markdown links when possible.
- Remove navigation, cookie banners, footers, and unrelated page chrome.
- Do not invent content.`;

  const prompt = `URL: ${url}
Site: ${siteName ?? "unknown"}
Title: ${title ?? "unknown"}

HTML:
"""
${html.slice(0, MAX_MARKDOWN_INPUT_CHARACTERS)}
"""
`;

  return { system, prompt };
}

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
${transcript.slice(0, MAX_MARKDOWN_INPUT_CHARACTERS)}
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

type GenerationOptions = Parameters<typeof generateTextWithModelId>[0];
type MarkdownConverterOptions = Pick<
  GenerationOptions,
  | "modelId"
  | "forceOpenRouter"
  | "openaiBaseUrlOverride"
  | "ollamaBaseUrlOverride"
  | "anthropicBaseUrlOverride"
  | "googleBaseUrlOverride"
  | "xaiBaseUrlOverride"
  | "fetchImpl"
  | "forceChatCompletions"
  | "requestOptions"
  | "retries"
  | "onRetry"
> &
  GenerationOptions["apiKeys"] & {
    onUsage?: (usage: {
      model: string;
      provider: LlmProvider;
      usage: LlmTokenUsage | null;
    }) => void;
  };

type MarkdownInput =
  | (Parameters<ConvertHtmlToMarkdown>[0] & { kind: "html" })
  | (Parameters<ConvertTranscriptToMarkdown>[0] & { kind: "transcript" });

export function createLlmMarkdownConverters(options: MarkdownConverterOptions): {
  html: ConvertHtmlToMarkdown;
  transcript: ConvertTranscriptToMarkdown;
} {
  const { onUsage, retries = 0 } = options;
  const modelOptions = {
    modelId: options.modelId,
    apiKeys: {
      xaiApiKey: options.xaiApiKey,
      googleApiKey: options.googleApiKey,
      openaiApiKey: options.openaiApiKey,
      anthropicApiKey: options.anthropicApiKey,
      openrouterApiKey: options.openrouterApiKey,
    },
    forceOpenRouter: options.forceOpenRouter,
    openaiBaseUrlOverride: options.openaiBaseUrlOverride,
    ollamaBaseUrlOverride: options.ollamaBaseUrlOverride,
    anthropicBaseUrlOverride: options.anthropicBaseUrlOverride,
    googleBaseUrlOverride: options.googleBaseUrlOverride,
    xaiBaseUrlOverride: options.xaiBaseUrlOverride,
    forceChatCompletions: options.forceChatCompletions,
    requestOptions: options.requestOptions,
    fetchImpl: options.fetchImpl,
    retries,
    onRetry: options.onRetry,
  };
  const convert = async (input: MarkdownInput): Promise<string> => {
    const { system, prompt } =
      input.kind === "html"
        ? buildHtmlToMarkdownPrompt(input)
        : buildTranscriptToMarkdownPrompt(input);
    const result = await generateTextWithModelId({
      ...modelOptions,
      prompt: { system, userText: prompt },
      timeoutMs: input.timeoutMs,
    });
    onUsage?.({
      model: result.canonicalModelId,
      provider: result.provider,
      usage: input.kind === "transcript" ? (result.usage ?? null) : result.usage,
    });
    return result.text;
  };
  return {
    html: (input) => convert({ ...input, kind: "html" }),
    transcript: (input) => convert({ ...input, kind: "transcript" }),
  };
}

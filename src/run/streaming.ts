export { mergeStreamingChunk } from "../shared/streaming-merge.js";

export function isGoogleStreamingUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as Record<string, unknown>;
  const message = typeof maybe.message === "string" ? maybe.message : "";
  const url = typeof maybe.url === "string" ? maybe.url : "";
  const responseBody = typeof maybe.responseBody === "string" ? maybe.responseBody : "";
  const errorText = `${message}\n${responseBody}`;

  const isStreamEndpoint =
    url.includes(":streamGenerateContent") || errorText.includes("streamGenerateContent");
  if (!isStreamEndpoint) return false;

  return (
    /does not support/i.test(errorText) ||
    /not supported/i.test(errorText) ||
    /Call ListModels/i.test(errorText) ||
    /supported methods/i.test(errorText)
  );
}

export function isStreamingTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown }).message === "string"
          ? String((error as { message?: unknown }).message)
          : "";
  return /timed out/i.test(message);
}

export function canStream({
  provider,
  prompt,
  transport,
}: {
  provider: "xai" | "openai" | "google" | "anthropic" | "zai" | "nvidia" | "vertex";
  prompt: { attachments?: Array<{ kind: "text" | "image" | "document" }> };
  transport: "cli" | "native" | "openrouter";
}): boolean {
  if (transport === "cli") return false;
  const attachments = prompt.attachments ?? [];
  if (attachments.some((attachment) => attachment.kind === "document")) return false;
  const streamableProviders: ReadonlySet<string> = new Set([
    "xai",
    "openai",
    "google",
    "anthropic",
    "zai",
    "nvidia",
  ]);
  return streamableProviders.has(provider);
}

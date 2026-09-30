import type { CliProvider } from "../config.js";

export function parseCliUserModelId(modelId: string): {
  provider: CliProvider;
  model: string | null;
} {
  const parts = modelId
    .trim()
    .split("/")
    .map((part) => part.trim());
  const provider = parts[1]?.toLowerCase();
  if (
    provider !== "claude" &&
    provider !== "codex" &&
    provider !== "gemini" &&
    provider !== "agent" &&
    provider !== "openclaw" &&
    provider !== "opencode" &&
    provider !== "copilot" &&
    provider !== "agy" &&
    provider !== "pi" &&
    provider !== "devin"
  ) {
    throw new Error(`Invalid CLI model id "${modelId}". Expected cli/<provider>/<model>.`);
  }
  const model = parts.slice(2).join("/").trim();
  return { provider, model: model.length > 0 ? model : null };
}

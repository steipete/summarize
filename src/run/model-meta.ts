import { parseGatewayStyleModelId } from "../llm/model-id.js";
import type { ModelAttempt } from "./types.js";

export function buildModelMetaFromAttempt(attempt: ModelAttempt) {
  if (attempt.transport === "cli") {
    return { provider: "cli" as const, canonical: attempt.userModelId };
  }
  const parsed = parseGatewayStyleModelId(attempt.llmModelId ?? attempt.userModelId);
  const canonical = attempt.userModelId.toLowerCase().startsWith("openrouter/")
    ? attempt.userModelId
    : parsed.canonical;
  return { provider: parsed.provider, canonical };
}

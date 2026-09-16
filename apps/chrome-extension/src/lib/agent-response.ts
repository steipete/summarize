import {
  type AgentAssistantMessage as AssistantMessage,
  parseSseStream,
} from "@steipete/summarize-core/runtime";
import { LocalizedError, message, readLocalizedMessage } from "./i18n";
import { parseSseEvent } from "./runtime-contracts";

type AgentJsonResponse = {
  ok?: boolean;
  assistant?: AssistantMessage;
  error?: string;
  localized?: unknown;
};

export type AgentStreamEvent =
  | { type: "chunk"; text: string }
  | { type: "assistant"; assistant: AssistantMessage };

export async function* readAgentResponse(res: Response): AsyncGenerator<AgentStreamEvent> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await res.json().catch(() => null)) as AgentJsonResponse | null;
    if (!json?.ok || !json.assistant) {
      const localized = readLocalizedMessage(json?.localized);
      if (localized) throw new LocalizedError(localized);
      if (json?.error) throw new Error(json.error);
      throw new LocalizedError(message("error.agentFailed"));
    }
    yield { type: "assistant", assistant: json.assistant };
    return;
  }

  if (!res.body) {
    throw new LocalizedError(message("error.streamBody"));
  }

  for await (const raw of parseSseStream(res.body)) {
    const event = parseSseEvent<AssistantMessage>(raw);
    if (!event) continue;
    if (event.event === "chunk") {
      yield { type: "chunk", text: event.data.text };
    } else if (event.event === "assistant") {
      yield { type: "assistant", assistant: event.data };
    } else if (event.event === "error") {
      const localized = readLocalizedMessage(event.data.localized);
      if (localized) throw new LocalizedError(localized);
      throw new Error(event.data.message);
    }
  }
}

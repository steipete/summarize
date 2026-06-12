import type { AssistantMessage } from "@earendil-works/pi-ai";
import { parseSseEvent } from "./runtime-contracts";
import { parseSseStream } from "./sse";

type AgentJsonResponse = { ok?: boolean; assistant?: AssistantMessage; error?: string };

export type AgentStreamEvent =
  | { type: "chunk"; text: string }
  | { type: "assistant"; assistant: AssistantMessage };

export async function* readAgentResponse(res: Response): AsyncGenerator<AgentStreamEvent> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await res.json().catch(() => null)) as AgentJsonResponse | null;
    if (!json?.ok || !json.assistant) {
      throw new Error(json?.error || "Agent failed");
    }
    yield { type: "assistant", assistant: json.assistant };
    return;
  }

  if (!res.body) {
    throw new Error("Missing agent response body");
  }

  for await (const raw of parseSseStream(res.body)) {
    const event = parseSseEvent<AssistantMessage>(raw);
    if (!event) continue;
    if (event.event === "chunk") {
      yield { type: "chunk", text: event.data.text };
    } else if (event.event === "assistant") {
      yield { type: "assistant", assistant: event.data };
    } else if (event.event === "error") {
      throw new Error(event.data.message);
    }
  }
}
